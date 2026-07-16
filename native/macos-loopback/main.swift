import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

// Core Audio tap setup follows Apple's documented aggregate-device design and
// the BSD-licensed AudioCap sample by Guilherme Rambo (see LICENSE-AudioCap).

enum CaptureError: Error, CustomStringConvertible {
    case operation(String, OSStatus)
    case format(String)

    var description: String {
        switch self {
        case let .operation(name, status): return "\(name) failed with Core Audio status \(status)."
        case let .format(message): return message
        }
    }
}

func requireSuccess(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else { throw CaptureError.operation(operation, status) }
}

func readValue<T>(_ object: AudioObjectID, selector: AudioObjectPropertySelector, initial: T) throws -> T {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<T>.size)
    var value = initial
    try requireSuccess(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "Read audio property")
    return value
}

final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "MusicVisualization.CoreAudioTap", qos: .userInteractive)
    private let output = FileHandle.standardOutput
    private(set) var sampleRate: UInt32 = 48_000

    func start() throws {
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDescription.uuid = UUID()
        tapDescription.muteBehavior = .unmuted
        tapDescription.isPrivate = true

        try requireSuccess(AudioHardwareCreateProcessTap(tapDescription, &tapID), "Create process tap")
        var streamDescription: AudioStreamBasicDescription = try readValue(
            tapID,
            selector: kAudioTapPropertyFormat,
            initial: AudioStreamBasicDescription()
        )
        guard streamDescription.mFormatID == kAudioFormatLinearPCM,
              streamDescription.mBitsPerChannel == 32,
              streamDescription.mChannelsPerFrame > 0 else {
            throw CaptureError.format("Core Audio returned an unsupported tap format.")
        }
        sampleRate = UInt32(streamDescription.mSampleRate.rounded())

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Music Visualization System Audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: tapDescription.uuid.uuidString
            ]]
        ]
        try requireSuccess(
            AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID),
            "Create aggregate device"
        )

        let channelCount = Int(streamDescription.mChannelsPerFrame)
        let nonInterleaved = streamDescription.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let ioBlock: AudioDeviceIOBlock = { [weak self] _, inputData, _, _, _ in
            guard let self else { return }
            // The wrapper has no immutable counterpart; only read through it because Core Audio owns this input list.
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            guard let first = buffers.first, let firstData = first.mData else { return }
            let frames: Int
            if nonInterleaved {
                frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            } else {
                frames = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * channelCount)
            }
            guard frames > 0 else { return }

            var mono = [Float](repeating: 0, count: frames)
            if nonInterleaved {
                let availableChannels = min(channelCount, buffers.count)
                for channel in 0..<availableChannels {
                    guard let data = buffers[channel].mData else { continue }
                    let source = data.assumingMemoryBound(to: Float.self)
                    for frame in 0..<frames { mono[frame] += source[frame] / Float(availableChannels) }
                }
            } else {
                let source = firstData.assumingMemoryBound(to: Float.self)
                for frame in 0..<frames {
                    var sum: Float = 0
                    for channel in 0..<channelCount { sum += source[frame * channelCount + channel] }
                    mono[frame] = sum / Float(channelCount)
                }
            }

            mono.withUnsafeBytes { bytes in
                guard let address = bytes.baseAddress else { return }
                try? self.output.write(contentsOf: Data(bytes: address, count: bytes.count))
            }
        }

        try requireSuccess(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue, ioBlock),
            "Create audio callback"
        )
        var rate = sampleRate.littleEndian
        output.write(Data(bytes: &rate, count: MemoryLayout.size(ofValue: rate)))
        try requireSuccess(AudioDeviceStart(aggregateID, ioProcID), "Start audio capture")
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            _ = AudioDeviceStop(aggregateID, ioProcID)
            if let ioProcID { _ = AudioDeviceDestroyIOProcID(aggregateID, ioProcID) }
            _ = AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
            ioProcID = nil
        }
        if tapID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }

    deinit { stop() }
}

do {
    let tap = SystemAudioTap()
    try tap.start()
    _ = readLine()
    tap.stop()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}

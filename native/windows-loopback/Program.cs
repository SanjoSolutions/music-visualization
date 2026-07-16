using NAudio.Wave;
using NAudio.CoreAudioApi;

Console.InputEncoding = System.Text.Encoding.UTF8;

try
{
    using var capture = new LowLatencyLoopbackCapture();
    using var output = Console.OpenStandardOutput();
    var provider = new BufferedWaveProvider(capture.WaveFormat)
    {
        DiscardOnBufferOverflow = true,
        ReadFully = false,
        BufferDuration = TimeSpan.FromMilliseconds(500)
    };
    var samples = provider.ToSampleProvider();
    var channels = capture.WaveFormat.Channels;
    var sampleBuffer = Array.Empty<float>();
    var monoBuffer = Array.Empty<float>();

    output.Write(BitConverter.GetBytes(capture.WaveFormat.SampleRate));
    output.Flush();

    capture.DataAvailable += (_, args) =>
    {
        provider.AddSamples(args.Buffer, 0, args.BytesRecorded);
        var wantedSamples = args.BytesRecorded / capture.WaveFormat.BlockAlign * channels;
        if (sampleBuffer.Length < wantedSamples) sampleBuffer = new float[wantedSamples];
        var read = samples.Read(sampleBuffer, 0, wantedSamples);
        var frames = read / channels;
        if (monoBuffer.Length < frames) monoBuffer = new float[frames];

        for (var frame = 0; frame < frames; frame++)
        {
            float sum = 0;
            var offset = frame * channels;
            for (var channel = 0; channel < channels; channel++) sum += sampleBuffer[offset + channel];
            monoBuffer[frame] = sum / channels;
        }

        output.Write(System.Runtime.InteropServices.MemoryMarshal.AsBytes(monoBuffer.AsSpan(0, frames)));
        output.Flush();
    };

    capture.StartRecording();
    Console.ReadLine();
    capture.StopRecording();
}

catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    Environment.ExitCode = 1;
}

sealed class LowLatencyLoopbackCapture : WasapiCapture
{
    public LowLatencyLoopbackCapture()
        : base(
            new MMDeviceEnumerator().GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia),
            useEventSync: true,
            audioBufferMillisecondsLength: 20)
    {
    }

    protected override AudioClientStreamFlags GetAudioClientStreamFlags()
        => AudioClientStreamFlags.Loopback;
}

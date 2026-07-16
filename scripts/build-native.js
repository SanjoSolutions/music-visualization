import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

if (process.platform === "linux") {
  console.log("Linux uses the system's PulseAudio/PipeWire capture client; no compilation required.");
  process.exit(0);
}

const command = process.platform === "win32" ? "dotnet" : "xcrun";
if (process.platform === "darwin") mkdirSync("native/macos-loopback/publish", { recursive: true });
const args = process.platform === "win32"
  ? [
      "publish",
      "native/windows-loopback/SystemAudioCapture.csproj",
      "-c", "Release",
      "-r", "win-x64",
      "--self-contained", "true",
      "-p:PublishSingleFile=true",
      "-p:IncludeNativeLibrariesForSelfExtract=true",
      "-o", "native/windows-loopback/publish",
    ]
  : [
      "swiftc",
      "native/macos-loopback/main.swift",
      "-O",
      "-framework", "CoreAudio",
      "-framework", "AudioToolbox",
      "-framework", "AVFoundation",
      "-Xlinker", "-sectcreate",
      "-Xlinker", "__TEXT",
      "-Xlinker", "__info_plist",
      "-Xlinker", "native/macos-loopback/Info.plist",
      "-o", "native/macos-loopback/publish/SystemAudioCapture",
    ];

const result = spawnSync(command, args, { stdio: "inherit", shell: false });

if (result.error) throw result.error;
process.exit(result.status ?? 1);

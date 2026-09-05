//
//  neo-audiotap — what the computer is playing, on stdout.
//
//  Electron cannot do this. Chromium's loopback capture is Windows-only, and macOS
//  will not let one application hear another through any API a renderer can reach.
//  What macOS *does* have, since 14.4, is Core Audio process taps: a public, driver
//  free way to read the system's own output. It needs native code, so this is native
//  code — a single command-line tool, spawned by the main process, that does exactly
//  one thing and writes the result to a pipe.
//
//  A separate process rather than a Node addon, deliberately. An addon is compiled
//  against one Electron's headers and has to be rebuilt for the next, and a crash in
//  it takes the whole app down with it. This can die on its own, and the recording
//  carries on with the microphone alone.
//
//  stdout is nothing but audio: signed 16-bit little-endian mono PCM.
//  stderr is nothing but JSON lines, one per event, so the parent can tell the
//  difference between "ready" and "macOS said no" without parsing prose.
//

import AudioToolbox
import CoreAudio
import Darwin
import Foundation

// MARK: - Talking to the parent

/// One JSON line on stderr. The parent reads these; a human reading them is a bonus.
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func fail(_ message: String, code: String = "failed") -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

// MARK: - The pipe

/**
 Audio is produced on a real-time thread and written on an ordinary one.

 Writing to a pipe is a syscall that blocks when the reader falls behind, and blocking
 inside a Core Audio render callback is how you get a recording full of clicks. So the
 callback only ever appends to this buffer — a memcpy under a lock, no syscalls — and
 a separate thread drains it.

 The cap is what happens when the parent stops reading altogether. Dropping the oldest
 audio keeps memory bounded and keeps the recording live; the alternative is growing
 until the machine complains.
 */
final class Pipe {
    private let lock = NSCondition()
    private var buffer = Data()
    private var closed = false
    private var dropped = 0

    private let cap = 4 * 1024 * 1024

    func append(_ bytes: UnsafeRawBufferPointer) {
        lock.lock()
        if buffer.count + bytes.count > cap {
            // Keep the newest: in a live meeting the last second matters and the one
            // from thirty seconds ago is already lost to whatever stalled us.
            let overflow = buffer.count + bytes.count - cap
            buffer.removeFirst(min(overflow, buffer.count))
            dropped += overflow
        }
        buffer.append(contentsOf: bytes)
        lock.signal()
        lock.unlock()
    }

    func close() {
        lock.lock()
        closed = true
        lock.signal()
        lock.unlock()
    }

    /// Runs until closed and drained. Called on its own thread.
    func drain() {
        let out = FileHandle.standardOutput
        var reported = 0
        while true {
            lock.lock()
            while buffer.isEmpty && !closed { lock.wait() }
            let chunk = buffer
            buffer.removeAll(keepingCapacity: true)
            let done = closed && chunk.isEmpty
            let lost = dropped
            lock.unlock()

            if done { return }
            if !chunk.isEmpty {
                // A parent that has gone away closes the pipe; there is nothing left
                // to record for, so stop rather than sitting on a dead descriptor.
                do { try out.write(contentsOf: chunk) } catch { return }
            }
            if lost > reported {
                reported = lost
                emit(["type": "dropped", "bytes": lost])
            }
        }
    }
}

let pipe = Pipe()

// MARK: - Core Audio

func audioObjectID(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var id = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id
    )
    return status == noErr && id != kAudioObjectUnknown ? id : nil
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    // Rebound explicitly: Core Audio wants somewhere to put a reference, and handing
    // it a typed pointer to a Swift-managed CFString is the thing the compiler warns
    // about — rightly, even though it is what every example does.
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        pointer.withMemoryRebound(to: UInt8.self, capacity: Int(size)) { raw in
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, raw)
        }
    }
    return status == noErr ? value as String? : nil
}

/**
 The tap, and the aggregate device that reads it.

 A tap on its own has no clock — it is a description of some audio, not a device. The
 aggregate is what turns it into something readable, and it needs a real device in it
 to be clocked by, which is why the system's own output device goes in beside the tap.

 `muteBehavior` is left unmuted on purpose: you have to be able to hear the meeting
 you are recording.
 */
func startTap() -> (aggregate: AudioObjectID, tap: AudioObjectID, format: AudioStreamBasicDescription) {
    guard let output = audioObjectID(kAudioHardwarePropertyDefaultSystemOutputDevice),
          let outputUID = stringProperty(output, kAudioDevicePropertyDeviceUID)
    else {
        fail("This Mac has no system output device to listen to.", code: "no-output")
    }

    // Everything the machine is playing, except this application: a recording that
    // captured Neo playing back a recording would be a loop with a microphone in it.
    let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
    description.uuid = UUID()
    description.isPrivate = true
    description.muteBehavior = .unmuted
    description.name = "Neo meeting tap"

    var tap = AudioObjectID(kAudioObjectUnknown)
    let tapStatus = AudioHardwareCreateProcessTap(description, &tap)
    guard tapStatus == noErr, tap != kAudioObjectUnknown else {
        // This is where a refused permission lands. There is no public API to ask for
        // audio capture up front or to check whether it was granted, so the honest
        // report is the one the system gave us.
        fail(
            "macOS would not let Neo listen to the computer's audio (Core Audio said \(tapStatus)). "
                + "Allow Neo under System Settings › Privacy & Security › Audio Recording.",
            code: "denied"
        )
    }

    let aggregateUID = UUID().uuidString
    let settings: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Neo meeting recorder",
        kAudioAggregateDeviceUIDKey: aggregateUID,
        kAudioAggregateDeviceMainSubDeviceKey: outputUID,
        // Private: it must not turn up in everybody's sound settings as a device.
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
        kAudioAggregateDeviceTapListKey: [
            [
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString
            ]
        ]
    ]

    var aggregate = AudioObjectID(kAudioObjectUnknown)
    let aggregateStatus = AudioHardwareCreateAggregateDevice(settings as CFDictionary, &aggregate)
    guard aggregateStatus == noErr, aggregate != kAudioObjectUnknown else {
        fail("Could not open the audio device that reads the tap (\(aggregateStatus)).")
    }

    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format) == noErr else {
        fail("The tap would not say what shape its audio is.")
    }

    return (aggregate, tap, format)
}

// MARK: - Running

let (aggregate, tap, format) = startTap()

let channels = max(1, Int(format.mChannelsPerFrame))
let sampleRate = format.mSampleRate > 0 ? format.mSampleRate : 48_000

/*
 Float32 in, signed 16-bit mono out.

 Mono because a meeting is speech and the second channel is the same speech again —
 it halves what goes down the pipe and is what transcription wants anyway. 16-bit
 because the extra headroom in a float is meaningless once this has been mixed with a
 microphone and encoded to Opus at the other end.
 */
var procID: AudioDeviceIOProcID?
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregate, nil) {
    _, inInputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    guard let first = buffers.first, let raw = first.mData else { return }

    let frames = Int(first.mDataByteSize) / MemoryLayout<Float32>.size / channels
    if frames <= 0 { return }

    let samples = raw.assumingMemoryBound(to: Float32.self)
    var out = [Int16](repeating: 0, count: frames)
    for frame in 0..<frames {
        var sum: Float32 = 0
        for channel in 0..<channels { sum += samples[frame * channels + channel] }
        let mixed = sum / Float32(channels)
        // Clamped rather than wrapped: a clipped peak is a moment of distortion, and
        // a wrapped one is a bang loud enough to make the whole recording unusable.
        let clamped = max(-1, min(1, mixed))
        out[frame] = Int16(clamped * 32_767)
    }
    out.withUnsafeBytes { pipe.append($0) }
}

guard ioStatus == noErr, let procID else {
    fail("Could not start reading the tap (\(ioStatus)).")
}

let writer = Thread { pipe.drain() }
writer.start()

guard AudioDeviceStart(aggregate, procID) == noErr else {
    fail("Could not start the audio device.")
}

emit(["type": "ready", "sampleRate": sampleRate, "channels": 1, "format": "s16le"])

/*
 Shutting down.

 The parent closing the pipe is the ordinary way this ends — the recording stopped, or
 the app quit — and the writer thread notices that on its next write. A signal is the
 other way. Both have to take the aggregate device and the tap back out of the system:
 leaving a private aggregate behind is a device that outlives the process that made it.
 */
func shutDown() -> Never {
    AudioDeviceStop(aggregate, procID)
    AudioDeviceDestroyIOProcID(aggregate, procID)
    AudioHardwareDestroyAggregateDevice(aggregate)
    AudioHardwareDestroyProcessTap(tap)
    pipe.close()
    exit(0)
}

// A pipe whose reader has gone would otherwise kill this outright, before the audio
// device has been handed back; the writer thread sees the failed write instead.
Darwin.signal(SIGPIPE, SIG_IGN)

/*
 Signals go through Dispatch rather than a C handler, because a C function pointer
 cannot close over the device it has to shut down — and shutting it down is the entire
 point of handling the signal. A private aggregate device left behind outlives the
 process that made it.
 */
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT, SIGHUP] {
    Darwin.signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { shutDown() }
    source.resume()
    signalSources.append(source)
}

// Stdin is the lifeline: the parent holds it open for as long as it wants audio, and
// closing it is how it says stop. Reading it also means an orphaned helper — a parent
// that died without saying anything — exits instead of recording into a dead pipe
// forever. On its own thread, so the main queue is free to answer a signal.
let lifeline = Thread {
    while true {
        var byte: UInt8 = 0
        if Darwin.read(0, &byte, 1) <= 0 { shutDown() }
    }
}
lifeline.start()

dispatchMain()

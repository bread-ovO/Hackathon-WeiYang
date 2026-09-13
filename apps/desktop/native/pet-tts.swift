import Foundation
import AVFoundation
import CoreFoundation

// One stdin JSON request and one stdout JSON reply. Never speaks to an output device.
func finish(_ object: [String: Any], _ status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
    exit(status)
}
func fail(_ code: String) -> Never { finish(["ok": false, "error": code]) }
let raw = FileHandle.standardInput.readData(ofLength: 8193)
guard raw.count <= 8192,
      let input = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
      let method = input["method"] as? String else { fail("PET_VOICE_INVALID") }
let voices = AVSpeechSynthesisVoice.speechVoices()
if method == "voices" {
    guard Set(input.keys) == Set(["method"]), voices.count <= 512 else { fail("PET_VOICE_UNAVAILABLE") }
    finish(["ok": true, "voices": voices.map { ["id": $0.identifier, "name": $0.name, "language": $0.language] }])
}
guard method == "synthesize", Set(input.keys) == Set(["method", "text", "voiceId", "rate"]),
      let text = input["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.unicodeScalars.count <= 240,
      !text.unicodeScalars.contains(where: { $0.value < 32 || ($0.value >= 127 && $0.value <= 159) }),
      let voiceId = input["voiceId"] as? String,
      let rateValue = input["rate"] as? NSNumber, CFGetTypeID(rateValue) != CFBooleanGetTypeID(),
      let rate = input["rate"] as? Double, rate.isFinite, rate >= 0.75, rate <= 1.25,
      let voice = voices.first(where: { $0.identifier == voiceId }) else { fail("PET_VOICE_INVALID") }
let synthesizer = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: text)
utterance.voice = voice
utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(rate)
var samples = Data()
var sampleRate: Double = 0
var frames = 0
var complete = false
var failure: String? = nil
let stateLock = NSLock()
synthesizer.write(utterance) { buffer in
    stateLock.lock()
    defer { stateLock.unlock() }
    guard failure == nil, !complete else { return }
    guard let pcm = buffer as? AVAudioPCMBuffer else { failure = "PET_VOICE_INVALID_PCM"; return }
    if pcm.frameLength == 0 { complete = true; return }
    let rate = pcm.format.sampleRate
    guard rate.isFinite, rate.rounded() == rate, rate >= 8000, rate <= 48000,
          pcm.format.channelCount >= 1, pcm.format.channelCount <= 2,
          pcm.format.commonFormat == .pcmFormatFloat32, !pcm.format.isInterleaved,
          let channelData = pcm.floatChannelData else { failure = "PET_VOICE_INVALID_PCM"; return }
    if sampleRate == 0 { sampleRate = rate }
    guard sampleRate == rate else { failure = "PET_VOICE_INVALID_PCM"; return }
    let count = Int(pcm.frameLength)
    guard frames + count <= Int(rate) * 12 else { failure = "PET_VOICE_TOO_LONG"; return }
    for index in 0..<count {
        var value: Float = 0
        for channel in 0..<Int(pcm.format.channelCount) { value += channelData[channel][index] / Float(pcm.format.channelCount) }
        guard value.isFinite, value >= -1, value <= 1 else { failure = "PET_VOICE_INVALID_PCM"; return }
        var bits = value.bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { samples.append(contentsOf: $0) }
    }
    frames += count
}
let deadline = Date().addingTimeInterval(18)
while Date() < deadline {
    stateLock.lock(); let finished = complete || failure != nil; stateLock.unlock()
    if finished { break }
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
stateLock.lock()
let finalFailure = failure, finalComplete = complete, finalFrames = frames, finalRate = sampleRate, finalSamples = samples
stateLock.unlock()
if let failure = finalFailure { synthesizer.stopSpeaking(at: .immediate); fail(failure) }
guard finalComplete else { synthesizer.stopSpeaking(at: .immediate); fail("PET_VOICE_TIMEOUT") }
guard finalFrames > 0 else { fail("PET_VOICE_UNAVAILABLE") }
finish(["ok": true, "pcm": ["sampleRate": Int(finalRate), "channels": 1, "format": "f32le", "frames": finalFrames, "data": finalSamples.base64EncodedString()]])

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  AUDIO_BITS_PER_SECOND, AUDIO_MIME_TYPES, CHUNK_MS, HEARTBEAT_MS, SEGMENT_MS
} from '@shared/recording'
import { call } from '@/lib/api'
import { createSystemAudioFeed, type SystemAudioFeed } from '@/lib/systemAudioNode'

/**
 * The microphone.
 *
 * It lives here, in a provider mounted above the router, for one reason: a recording
 * must not stop because you navigated. You will look at the board in the middle of a
 * meeting, and a `MediaRecorder` owned by the meeting page would go with the page.
 *
 * Everything this holds is disposable. The audio is on disk after every second,
 * every fact about the recording is a row in main, and this object owns only the
 * live objects — the stream, the recorder, the timers — none of which survive a
 * crash and none of which need to. If this window disappears, main notices the
 * heartbeat stop and marks the capture interrupted with all of the audio intact.
 *
 * The two failures it does handle itself are the common ones. A Mac that sleeps ends
 * the microphone track without telling anybody, so a watchdog looks every couple of
 * seconds and a new segment is started the moment one can be — and the segment
 * before it was already closed and complete. A five-minute rollover does the same
 * thing deliberately, so that no single file is ever more than five minutes of risk.
 */

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'reconnecting' | 'stopping'

export interface RecorderState {
  status: RecorderStatus
  meetingId: string | null
  /** So the bar that follows you around can take you back to the meeting. */
  projectId: string | null
  recordingId: string | null
  /** Sound captured so far, across every segment. */
  elapsedMs: number
  bytes: number
  /** 0–1, for the meter that proves the microphone is hearing something. */
  level: number
  /**
   * What is actually going into the file. Never inferred from a setting — a setting
   * says what was asked for, and this says what was got.
   */
  capturing: 'mic' | 'both'
  /** Why the computer's own sound is not in it, when it is not. */
  inputNote: string
  error: string
}

interface RecorderApi extends RecorderState {
  start: (meetingId: string, projectId: string) => Promise<void>
  /** Pick an interrupted capture back up; the audio already on disk is kept. */
  resume: (recordingId: string, meetingId: string, projectId: string) => Promise<void>
  stop: () => Promise<void>
  dismissError: () => void
}

const IDLE: RecorderState = {
  status: 'idle',
  meetingId: null,
  projectId: null,
  recordingId: null,
  elapsedMs: 0,
  bytes: 0,
  level: 0,
  capturing: 'mic',
  inputNote: '',
  error: ''
}

const RecorderContext = createContext<RecorderApi>({
  ...IDLE,
  start: async () => {},
  resume: async () => {},
  stop: async () => {},
  dismissError: () => {}
})

export const useRecorder = (): RecorderApi => useContext(RecorderContext)

const pickMimeType = (): string =>
  AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''

export function RecorderProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = useQueryClient()
  const [state, setState] = useState<RecorderState>(IDLE)

  /* Everything below is machinery, not state: none of it should cause a render. */
  const recordingId = useRef<string | null>(null)
  /**
   * Three streams, and the distinction matters.
   *
   * `mic` and `system` are the real inputs, and they are the ones that can die — a
   * lid closing, a device unplugged. `stream` is what is actually recorded: the two
   * of them mixed into one by the Web Audio graph below. Its track is *always* live,
   * because it is generated rather than captured, so the watchdog has to look at the
   * sources and never at it.
   */
  const mic = useRef<MediaStream | null>(null)
  const system = useRef<MediaStream | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const audio = useRef<AudioContext | null>(null)
  /** The computer's own sound, when it could be had. Not a MediaStream: see the feed. */
  const tap = useRef<SystemAudioFeed | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const segmentId = useRef<string | null>(null)
  const segmentStartedAt = useRef(0)
  /** Sound in the segments that are already closed. */
  const capturedMs = useRef(0)
  /** Bytes in the closed segments, and in the one still open, kept apart so the
   *  running total is never double counted when a segment rolls over. */
  const closedBytes = useRef(0)
  const openBytes = useRef(0)
  const stopping = useRef(false)
  /**
   * A rollover or a reconnection is already under way. The watchdog looks every two
   * seconds and either of those can take longer than that — opening a microphone
   * after a suspend routinely does — and starting a second one would leave an
   * orphaned segment with nothing writing into it.
   */
  const changing = useRef(false)
  const analyser = useRef<AnalyserNode | null>(null)

  /**
   * Chunks are appended in the order they were recorded, always. Two overlapping
   * writes to the same file would interleave a WebM cluster with the one after it
   * and make the segment unplayable from that point on, so every write goes through
   * one chain rather than being fired off as it arrives.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    // The chain must not break on a failed write: the next chunk is still wanted.
    queue.current = next.catch(() => {})
    return next
  }

  const patch = useCallback((next: Partial<RecorderState>) => {
    setState((current) => ({ ...current, ...next }))
  }, [])

  /* ------------------------------------------------------------- one segment */

  const closeCurrentSegment = useCallback(async (): Promise<void> => {
    const id = segmentId.current
    if (!id) return
    segmentId.current = null
    const duration = Math.max(0, Date.now() - segmentStartedAt.current)
    capturedMs.current += duration
    closedBytes.current += openBytes.current
    openBytes.current = 0
    await enqueue(() => call('recording:closeSegment', { segmentId: id, durationMs: duration }))
  }, [])

  const beginSegment = useCallback(async (): Promise<MediaRecorder | null> => {
    const id = recordingId.current
    const source = stream.current
    if (!id || !source) return null

    const { segmentId: newSegment } = await call('recording:openSegment', { id })
    segmentId.current = newSegment
    segmentStartedAt.current = Date.now()
    openBytes.current = 0

    const mimeType = pickMimeType()
    const next = new MediaRecorder(source, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND
    })

    next.ondataavailable = (event): void => {
      if (!event.data || event.data.size === 0) return
      const target = newSegment
      void enqueue(async () => {
        const buffer = await event.data.arrayBuffer()
        // Base64 through the bridge: an ArrayBuffer over IPC is copied anyway, and a
        // second of Opus is about 6 KB, so the encoding costs nothing worth saving.
        let binary = ''
        const view = new Uint8Array(buffer)
        for (let i = 0; i < view.length; i += 0x8000) {
          binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
        }
        const result = await call('recording:appendChunk', {
          segmentId: target,
          data: btoa(binary)
        })
        // What main reports back is the size of the file on disk, which is the only
        // number worth showing: it is what the recording actually costs.
        if (segmentId.current === target) openBytes.current = result.bytes
        return result
      }).catch(() => {
        // A failed append is a disk problem, and the next second will fail too. Say
        // so once rather than tearing the recording down under the user.
        patch({ error: 'Could not write the audio to disk. Check that there is space free.' })
      })
    }

    next.start(CHUNK_MS)
    recorder.current = next
    return next
  }, [patch])

  /**
   * Roll over to the next file without dropping a word: the new recorder is started
   * on the same stream *before* the old one is stopped, so the two overlap by a few
   * milliseconds instead of leaving a gap where somebody was talking.
   */
  const rollSegment = useCallback(async (): Promise<void> => {
    if (changing.current) return
    changing.current = true
    const previous = recorder.current
    const previousSegment = segmentId.current
    const duration = Math.max(0, Date.now() - segmentStartedAt.current)

    try {
      closedBytes.current += openBytes.current
      await beginSegment()

      // Each recorder's handler was given its own segment id when it was created, so
      // the last chunk `stop()` emits lands in the segment it belongs to and not in
      // the one that has just been opened.
      if (previous && previous.state !== 'inactive') previous.stop()
      if (previousSegment) {
        capturedMs.current += duration
        await enqueue(() =>
          call('recording:closeSegment', { segmentId: previousSegment, durationMs: duration })
        )
      }
    } catch {
      // The watchdog will find the recorder inactive on its next look and reconnect,
      // which is the same repair by a different route.
    } finally {
      changing.current = false
    }
  }, [beginSegment])

  /* ------------------------------------------------------------- the inputs */

  /**
   * What the computer itself is playing — the other half of a video call.
   *
   * There is no single way to get this, because operating systems disagree about
   * whether an application may hear another application at all.
   *
   * On Windows it may: `getDisplayMedia` comes back with the system's own output,
   * because main answers the request with `loopback`. Nothing has to be installed.
   *
   * On macOS it may not, full stop — Electron says so in as many words, and there is
   * no flag that changes it. Short of shipping a kernel-level audio driver, the only
   * way a Mac lets one app hear another is a virtual audio device that both of them
   * are pointed at: BlackHole, Loopback, an aggregate device. So this looks for the
   * one named in Settings and records it as a second microphone. It is not a
   * workaround for something that should work; it is how every recorder on the
   * platform does this.
   *
   * Either way, failing is allowed. A meeting recorded from the microphone alone is
   * most of a meeting; a meeting not recorded because the clever half did not work
   * is none of it. What must never happen is failing *quietly*, so what was actually
   * captured is on the screen the whole time it is being captured.
   */
  const openSystemAudio = useCallback(
    async (deviceName: string): Promise<{ stream: MediaStream | null; note: string }> => {
      if (window.api.platform === 'win32') {
        try {
          // Video is asked for because `getDisplayMedia` will not run without it, and
          // thrown away immediately: main hands back sound and no picture at all.
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          display.getVideoTracks().forEach((track) => {
            track.stop()
            display.removeTrack(track)
          })
          if (display.getAudioTracks().length === 0) {
            return { stream: null, note: 'Windows did not hand over the computer’s sound.' }
          }
          return { stream: display, note: '' }
        } catch {
          return { stream: null, note: 'The computer’s own sound could not be captured.' }
        }
      }

      if (!deviceName) {
        return {
          stream: null,
          note: 'Only the microphone. Set up a virtual audio device in Settings to catch the other side of a call.'
        }
      }

      const devices = await navigator.mediaDevices.enumerateDevices()
      const device = devices.find((d) => d.kind === 'audioinput' && d.label === deviceName)
      if (!device) {
        return { stream: null, note: `“${deviceName}” is not plugged in. Recording the microphone only.` }
      }
      try {
        return {
          stream: await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: device.deviceId },
              // Every one of these is off deliberately. They exist to make a human
              // voice in a room intelligible; run over sound that is already clean
              // they chew the ends off words and duck one speaker under another.
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          }),
          note: ''
        }
      } catch {
        return { stream: null, note: `Could not open “${deviceName}”. Recording the microphone only.` }
      }
    },
    []
  )

  /**
   * Opens everything and mixes it into the one stream that gets recorded.
   *
   * The mixing is a Web Audio graph rather than two recorders, because two files
   * would have to be kept in step with each other forever afterwards — through a
   * five-minute rollover, a sleep, a transcription — and they would drift. One
   * stream is one recording, and everything downstream stays as simple as it is.
   */
  const openInputs = useCallback(async (): Promise<void> => {
    // macOS only shows its permission sheet in answer to a request from the
    // application itself; getUserMedia alone is refused without a word.
    await call('recording:requestMic')
    const settings = await call('settings:get')

    /*
     * The computer's own sound, by whichever of the two routes works.
     *
     * The native tap is tried first and is the one that needs nothing installed: a
     * Core Audio process tap, read by the helper the main process spawns. It is only
     * ever absent for a reason worth reporting — an old macOS, a refused permission,
     * a build without the helper — and then the virtual-device route is still there
     * for anyone who has set one up.
     */
    let taps: Awaited<ReturnType<typeof call<'systemAudio:start'>>> | null = null
    let computer: { stream: MediaStream | null; note: string } = { stream: null, note: '' }

    if (settings.captureSystemAudio) {
      const { available } = await call('systemAudio:available')
      if (available) {
        const started = await call('systemAudio:start')
        if (started.ok) taps = started
        else computer = { stream: null, note: started.reason }
      }
      if (!taps) {
        const fallback = await openSystemAudio(settings.systemAudioDevice)
        if (fallback.stream) computer = fallback
        else if (!computer.note) computer = fallback
      }
    }

    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Left on for the microphone, and it earns its keep twice over here: it is
        // what stops the far end coming back a second time through the speakers.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    mic.current = microphone
    system.current = computer.stream

    /*
     * The graph runs at the tap's own rate when there is one, so its samples go in
     * without being resampled — the microphone is resampled into the context by the
     * browser either way, and of the two it is the one that can afford it.
     */
    const context = taps ? new AudioContext({ sampleRate: taps.sampleRate }) : new AudioContext()
    await context.resume().catch(() => {})
    const bus = context.createGain()
    const destination = context.createMediaStreamDestination()
    const meter = context.createAnalyser()
    meter.fftSize = 512

    context.createMediaStreamSource(microphone).connect(bus)
    if (computer.stream) context.createMediaStreamSource(computer.stream).connect(bus)

    if (taps) {
      const feed = await createSystemAudioFeed(context)
      if (feed) {
        feed.node.connect(bus)
        tap.current = feed
      } else {
        void call('systemAudio:stop')
        taps = null
        computer = { stream: null, note: 'The computer’s sound could not be mixed in.' }
      }
    }

    bus.connect(destination)
    bus.connect(meter)

    audio.current = context
    analyser.current = meter
    stream.current = destination.stream
    const both = Boolean(taps) || Boolean(computer.stream)
    patch({ capturing: both ? 'both' : 'mic', inputNote: both ? '' : computer.note })
  }, [openSystemAudio, patch])

  const releaseMicrophone = useCallback((): void => {
    recorder.current = null
    tap.current?.release()
    tap.current = null
    void call('systemAudio:stop').catch(() => {})
    for (const source of [mic.current, system.current, stream.current]) {
      source?.getTracks().forEach((track) => track.stop())
    }
    mic.current = null
    system.current = null
    stream.current = null
    analyser.current = null
    void audio.current?.close().catch(() => {})
    audio.current = null
  }, [])

  /**
   * The microphone has gone — asleep, unplugged, taken by something else. The
   * segment that was open is closed with what it got, and a new one is opened as
   * soon as a microphone can be had again. The recording itself never stops; from
   * the database's point of view nothing happened but a segment boundary.
   */
  const reconnect = useCallback(async (): Promise<void> => {
    if (stopping.current || changing.current || !recordingId.current) return
    changing.current = true
    patch({ status: 'reconnecting' })
    try {
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    } catch {
      /* Already gone, which is the case we are here for. */
    }
    await closeCurrentSegment()
    releaseMicrophone()

    try {
      await openInputs()
      await beginSegment()
      patch({ status: 'recording', error: '' })
    } catch {
      // Left in `reconnecting`; the watchdog will be back in two seconds. A meeting
      // that outlives a borrowed microphone is worth waiting for.
      patch({ error: 'Waiting for the microphone to come back…' })
    } finally {
      changing.current = false
    }
  }, [beginSegment, closeCurrentSegment, openInputs, patch, releaseMicrophone])

  /* ------------------------------------------------------------ the controls */

  const begin = useCallback(
    async (meetingId: string, projectId: string, id: string): Promise<void> => {
      recordingId.current = id
      capturedMs.current = 0
      closedBytes.current = 0
      openBytes.current = 0
      stopping.current = false
      changing.current = false
      patch({
        status: 'starting',
        meetingId,
        projectId,
        recordingId: id,
        elapsedMs: 0,
        bytes: 0,
        inputNote: '',
        error: ''
      })

      await openInputs()
      await beginSegment()
      patch({ status: 'recording' })
    },
    [beginSegment, openInputs, patch]
  )

  const start = useCallback(
    async (meetingId: string, projectId: string): Promise<void> => {
      try {
        const recording = await call('recording:start', { meetingId })
        await begin(meetingId, projectId, recording.id)
        void client.invalidateQueries()
      } catch (error) {
        releaseMicrophone()
        recordingId.current = null
        setState({ ...IDLE, error: describe(error) })
      }
    },
    [begin, client, releaseMicrophone]
  )

  const resume = useCallback(
    async (id: string, meetingId: string, projectId: string): Promise<void> => {
      try {
        const recording = await call('recording:resume', { id })
        await begin(meetingId, projectId, recording.id)
        // What is already on disk counts towards the clock from the first frame.
        capturedMs.current = recording.durationMs
        void client.invalidateQueries()
      } catch (error) {
        releaseMicrophone()
        recordingId.current = null
        setState({ ...IDLE, error: describe(error) })
      }
    },
    [begin, client, releaseMicrophone]
  )

  const stop = useCallback(async (): Promise<void> => {
    const id = recordingId.current
    if (!id || stopping.current) return
    stopping.current = true
    patch({ status: 'stopping' })

    try {
      const active = recorder.current
      if (active && active.state !== 'inactive') {
        // `stop()` emits one last chunk. Waiting for it is the difference between
        // keeping the final sentence of the meeting and losing it.
        await new Promise<void>((resolve) => {
          const done = (): void => resolve()
          active.addEventListener('stop', done, { once: true })
          active.stop()
          setTimeout(done, 2000)
        })
      }
      await closeCurrentSegment()
      releaseMicrophone()
      // Everything queued is on disk before the recording is declared finished, so
      // transcription never starts against a file that is still being written.
      await queue.current
      await call('recording:stop', { id, durationMs: capturedMs.current })
    } catch (error) {
      patch({ error: describe(error) })
    } finally {
      recordingId.current = null
      stopping.current = false
      setState(IDLE)
      void client.invalidateQueries()
    }
  }, [client, closeCurrentSegment, patch, releaseMicrophone])

  /* ------------------------------------------------------------------ timers */

  // The clock, the meter and the size, once a second. Cheap, and it is the only
  // proof on screen that the microphone is actually hearing the room.
  useEffect(() => {
    if (state.status === 'idle') return
    const timer = setInterval(() => {
      const live = segmentId.current ? Date.now() - segmentStartedAt.current : 0
      let level = 0
      if (analyser.current) {
        const data = new Uint8Array(analyser.current.frequencyBinCount)
        analyser.current.getByteTimeDomainData(data)
        let peak = 0
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128))
        level = Math.min(1, peak / 90)
      }
      patch({
        elapsedMs: capturedMs.current + live,
        bytes: closedBytes.current + openBytes.current,
        level
      })
    }, 250)
    return () => clearInterval(timer)
  }, [state.status, patch])

  // The heartbeat. Main marks a capture interrupted when this stops, which is what
  // makes a crashed or reloaded window recoverable rather than merely lost.
  useEffect(() => {
    if (state.status === 'idle') return
    const timer = setInterval(() => {
      const id = recordingId.current
      if (!id) return
      const live = segmentId.current ? Date.now() - segmentStartedAt.current : 0
      void call('recording:heartbeat', { id, durationMs: capturedMs.current + live }).catch(() => {})
    }, HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, [state.status])

  // The watchdog: the five-minute rollover, and the microphone that quietly died.
  useEffect(() => {
    if (state.status !== 'recording' && state.status !== 'reconnecting') return
    const timer = setInterval(() => {
      if (stopping.current || changing.current) return
      // The mixed stream's own track is generated and therefore always "live", so
      // what is checked is the real inputs behind it. A system stream that is simply
      // absent is a settled state, not a fault — it was already reported once.
      const micLive = mic.current?.getAudioTracks().some((t) => t.readyState === 'live')
      const systemDied =
        system.current !== null &&
        !system.current.getAudioTracks().some((t) => t.readyState === 'live')
      const inactive = !recorder.current || recorder.current.state === 'inactive'

      if (!stream.current || !micLive || systemDied || inactive) {
        void reconnect()
        return
      }
      if (Date.now() - segmentStartedAt.current >= SEGMENT_MS) void rollSegment()
    }, 2000)
    return () => clearInterval(timer)
  }, [state.status, reconnect, rollSegment])

  // Sleep. The segment is closed on the way down so the file on disk is complete,
  // and a new one is opened on the way back up.
  useEffect(() => {
    return window.api.onPower((event) => {
      if (recordingId.current === null || stopping.current) return
      if (event === 'suspend') {
        if (changing.current) return
        changing.current = true
        patch({ status: 'reconnecting' })
        try {
          if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
        } catch {
          /* Nothing to stop. */
        }
        void closeCurrentSegment().finally(() => {
          changing.current = false
        })
      } else {
        void reconnect()
      }
    })
  }, [closeCurrentSegment, patch, reconnect])

  /*
   * The pipeline runs in main whether or not anything is on screen, so the screen is
   * told when a recording moved rather than polling for it. Invalidating everything
   * is what every other write in this app does, and for the same reason: a finished
   * recap moves the activity log, the meeting row and the project's clock as well.
   */
  useEffect(() => {
    return window.api.onRecording((event) => {
      void client.invalidateQueries()
      if (event.type === 'interrupted' && event.recordingId === recordingId.current) {
        // Main has decided this capture is dead. Let go of the microphone rather than
        // going on writing into a recording that is no longer marked as running.
        recordingId.current = null
        releaseMicrophone()
        setState({ ...IDLE, error: 'The recording was interrupted. What was captured is safe.' })
      }
    })
  }, [client, releaseMicrophone])

  // The helper can stop on its own — an output device changed under it, or it
  // crashed. The microphone carries on, and the panel stops claiming otherwise.
  useEffect(() => {
    return window.api.onSystemAudioStopped(() => {
      if (recordingId.current === null) return
      tap.current?.release()
      tap.current = null
      patch({
        capturing: 'mic',
        inputNote: 'The computer’s sound stopped. Still recording the microphone.'
      })
    })
  }, [patch])

  const value = useMemo<RecorderApi>(
    () => ({ ...state, start, resume, stop, dismissError: () => patch({ error: '' }) }),
    [state, start, resume, stop, patch]
  )

  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>
}

function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Neo was not allowed to use the microphone. Grant it in System Settings › Privacy & Security › Microphone.'
    }
    if (error.name === 'NotFoundError') return 'No microphone was found.'
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

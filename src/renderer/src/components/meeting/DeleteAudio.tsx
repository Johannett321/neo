import type { RecordingView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { ConfirmButton } from '@/components/primitives'

/**
 * Deleting a recording means deleting the *audio*, and only the audio.
 *
 * The sound is the part that costs megabytes; the transcript and the recap are a few
 * kilobytes of text and they are the part you will actually go back to. So there is
 * one delete on this feature and it is this one — it frees the space and keeps every
 * word, which is what "delete the recording" almost always means once you have read
 * it once.
 *
 * One component rather than a button in each place it appears, so the sentence in
 * the confirmation is written once and cannot drift between the rail and the player.
 */
export function DeleteAudioButton({
  recording,
  className
}: {
  recording: RecordingView
  className?: string
}): React.JSX.Element | null {
  const deleteAudio = useApiMutation('recording:deleteAudio')
  if (recording.audioDeletedAt) return null

  /*
   * Before there is a transcript the audio is the only copy of the meeting, and main
   * refuses to delete it. A button that asks for confirmation and then quietly fails
   * is worse than no button, so this says what it is waiting for instead — and the
   * way to get rid of a recording that will never transcribe is to remove it
   * outright, which is what that action at the bottom of the screen is for.
   */
  if (recording.transcriptState !== 'done') {
    return (
      <span className="text-[11px] text-base-content/35">
        The audio can go once it has been transcribed
      </span>
    )
  }

  return (
    <ConfirmButton
      label={`Delete the audio · frees ${formatBytes(recording.bytes)}`}
      title="Delete the audio?"
      body={`This frees ${formatBytes(recording.bytes)}. The transcript, the speakers and the recap all stay exactly as they are — only the sound goes, and it cannot be got back.`}
      confirmLabel="Delete the audio"
      className={className ?? 'btn btn-ghost btn-xs text-base-content/40 hover:text-error'}
      onConfirm={() => deleteAudio.mutate({ id: recording.id })}
    />
  )
}

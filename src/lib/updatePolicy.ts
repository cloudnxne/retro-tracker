/**
 * A new app version must never reload the page mid-workout.
 *   detected: the new version just finished downloading. Never reload now (you might be reading).
 *   resume:   the app came back to the foreground (effectively "next open").
 *   user:     tapped "Restart to update" in ME.
 * Any trigger is refused while a session is live on this device.
 */
export type UpdateTrigger = 'detected' | 'resume' | 'user';

export function shouldApplyUpdate(s: { ready: boolean; liveSession: boolean; trigger: UpdateTrigger }): boolean {
  return s.ready && !s.liveSession && s.trigger !== 'detected';
}

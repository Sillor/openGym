// Whether this instance can read a meal, and what to say when a read fails. One sentence per
// cause, so "the photo is too big" is never reported as "the coach can't read this".

import { useStore } from '../../store/useStore.js'
import { coachAvailable } from '../../lib/coach.js'
import { t } from '../../lib/i18n.js'

export function serverCoach() {
  const { user, config, coachLocal } = useStore.getState()
  return coachAvailable(config, user, { mobile: false, coachMode: coachLocal?.mode }) && !!(user && config?.coach?.enabled)
}

/** A short line for a failed read. `fix` is a correction, `photo` a photo read. */
export function readError(error, { photo = false, fix = false } = {}) {
  switch (error) {
    case 'cap': return t('Today’s read limit is used up. You can still enter it yourself.')
    case 'auth': return t('Sign in, and turn the coach on, to read a meal.')
    case 'too long': return t('That is a lot of text. Shorten it a little and try again.')
    case 'too big': return t('That photo is too large to send. Try another one.')
    case 'timeout': return t('The coach took too long to answer. Try again.')
    case 'offline': return t('No connection to the server. Try again when you are online.')
    case 'parse':
      if (fix) return t('The coach’s answer didn’t make sense. Try saying it another way.')
      return photo ? t('The coach couldn’t make out a meal in that photo.') : t('The coach couldn’t make out a meal in that.')
    default:
      return fix ? t('The coach couldn’t update this meal. Try again.') : t('The coach couldn’t read this meal. Try again.')
  }
}

// GET /api/leads/usage?day=YYYY-MM-DD — how many Places searches have been run
// today and this month, against Google's free 1,000-a-month allowance.
//
// `day` is the browser's local date so the daily count resets at the user's
// midnight. Never throws: a usage counter failing should not stop Lead Finder
// from working.

import { handle, json } from '../../../lib/http.js';
import { cleanDay, readUsage, DAY_TARGET, MONTH_FREE_LIMIT } from '../../../lib/usage.js';

export const onRequestGet = handle(async ({ request, env }) => {
  const day = cleanDay(new URL(request.url).searchParams.get('day'));
  if (!env.DB) {
    return json({ today: 0, dayTarget: DAY_TARGET, month: 0, monthLimit: MONTH_FREE_LIMIT, monthRemaining: MONTH_FREE_LIMIT });
  }
  try {
    return json(await readUsage(env.DB, day));
  } catch {
    return json({ today: 0, dayTarget: DAY_TARGET, month: 0, monthLimit: MONTH_FREE_LIMIT, monthRemaining: MONTH_FREE_LIMIT });
  }
});

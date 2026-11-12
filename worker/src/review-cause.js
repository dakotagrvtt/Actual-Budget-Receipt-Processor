// Stable review groups for the queue. New entries keep a short explanation; old entries can be classified from their saved summary.
export const REVIEW_CAUSES = [
  ['matching', 'Bank match'], ['cash', 'Cash purchases'], ['category', 'Categories'],
  ['reading', 'Reading corrections'], ['service', 'Service problems'], ['return', 'Returns'], ['other', 'Other review'],
];
const labels = new Map(REVIEW_CAUSES);
export function reviewCause(entry, summary = null) {
  if (entry?.archived || entry?.reviewed || entry?.manualLink?.keep) return null;
  const result = String(entry?.result ?? '').replace(/^dry-run:/, '');
  if (!entry?.waiting && !/review|failed/.test(result) && !entry?.error && !entry?.creating && !entry?.resolutionPending && !entry?.filing) return null;
  const text = (summary?.problems ?? []).map(String).join(' ');
  const receipt = summary?.receipt ?? entry?.reading?.receipt;
  let code, reason;
  if (entry?.creating) { code = 'service'; reason = 'Check the outcome of an earlier cash creation.'; }
  else if (entry?.filing || entry?.resolutionPending || entry?.fixedOnPage?.summaryFailed) { code = 'service'; reason = 'The receipt record still needs to be saved.'; }
  else if (receipt?.is_return || Number(receipt?.total) < 0 || /return\/refund/.test(text)) { code = 'return'; reason = 'Return or refund: handle it in Actual, then archive.'; }
  else if (/\bcash\b(?!\s*back)/i.test(receipt?.payment_method ?? '') || /paid in cash/i.test(text)) { code = 'cash'; reason = 'Cash purchase: create it here, or archive if already entered.'; }
  else if (/total is missing|no readable|unreadable|could not (read|convert)|invalid.*(json|reading)|line items add up|printed subtotal/i.test(text + ' ' + (entry?.error ?? ''))) { code = 'reading'; reason = 'Check the receipt reading and amounts.'; }
  else if (entry?.waiting || /no transaction|no matching|more than one transaction|no payee|older charge|amount and date match|still pending|undated receipt/i.test(text)) { code = 'matching'; reason = entry?.waiting ? 'Waiting for the bank charge.' : 'Check the reading or choose the bank charge.'; }
  else if (result === 'failed' || entry?.error || /could not reach|timeout|unavailable|connection|HTTP [45]\d\d/i.test(text)) { code = 'service'; reason = 'A service or processing failure needs attention.'; }
  else if (summary?.transaction || /category|categorized|confidence|unsure|doubt|split|check it/i.test(text)) { code = 'category'; reason = 'Check the item categories in this receipt.'; }
  else if (entry?.review?.cause && labels.has(entry.review.cause)) return entry.review;
  else { code = 'other'; reason = 'Open the receipt to see what needs attention.'; }
  return { cause: code, label: labels.get(code), reason };
}

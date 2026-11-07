// The per-item rows replay.js saves for the threshold sweep (--items-out). Pure, so they can be tested.

/**
 * One row per item for the threshold sweep. `pick`, `topProbability` and `margin` are the decider's own answer after any
 * keyword-hint reweighing and before settleUnsure fell back to the store's category (categorize.js keeps them in
 * item.decided); `filed` is what the pipeline made of it. When a keyword hint changed the answer, `modelPick`,
 * `modelTopProbability` and `modelMargin` are the model's own, and `keywordTooWeak` says a keyword was considered but
 * would have failed the gate. Null margin = unknown (no probabilities).
 * The per-receipt answer (RECEIPT_CHECK) is on every row, so the bar and the item-vs-receipt rule can be tuned offline:
 * `receiptPick`, `receiptTopProbability` and `receiptMargin` (null when it wasn't asked), `itemProbabilityOfReceiptPick` (the
 * item's own probability for that category), and `pulledByReceipt` (true when the item took the receipt's category; then `pick` is
 * still what the item said by itself and `filed` the outcome).
 */
export const itemRows = (file, receipt) => (receipt?.items ?? []).filter((it) => it.decided || it.source === 'keyword').map((it) => {
  const d = it.decided ?? { category: it.category, confidence: it.confidence, margin: null, model: null };
  const rc = receipt.receiptCheck ?? null;
  return {
    file,
    item: it.description,
    amount: it.amount,
    pick: d.category,
    topProbability: d.confidence,
    margin: d.margin,
    modelPick: d.model?.category ?? null,
    modelTopProbability: d.model?.confidence ?? null,
    modelMargin: d.model?.margin ?? null,
    keywordTooWeak: it.keywordTooWeak ?? null,
    receiptPick: rc?.category ?? null,
    receiptTopProbability: rc?.category ? rc.confidence : null,
    receiptMargin: rc?.margin ?? null,
    itemProbabilityOfReceiptPick: (rc?.category && (it.reweighed ?? it.probabilities)?.[rc.category]) ?? null,
    pulledByReceipt: Boolean(it.receiptSaid),
    source: it.source ?? 'model',
    filed: it.category,
    fellBack: Boolean(it.fellBack),
  };
});

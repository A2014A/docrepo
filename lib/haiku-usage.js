/* S5 fix (11.11.2026): IDENTIFY_MONTHLY_TOKEN_CAP enforcement. One shared
 * module so every Haiku call site -- the live server endpoints AND the
 * standalone L1 batch scripts, which run as separate processes and can't
 * share in-memory state -- records to and checks against the SAME
 * HaikuUsage table. Takes a Prisma client as a parameter rather than
 * creating its own, so callers reuse the connection they already have. */

function currentYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getMonthlyHaikuUsage(prisma, yearMonth) {
  const ym = yearMonth || currentYearMonth();
  const row = await prisma.haikuUsage.findUnique({ where: { yearMonth: ym } });
  return row || { yearMonth: ym, inputTokens: 0, outputTokens: 0, callCount: 0 };
}

function haikuCap() {
  const cap = parseInt(process.env.IDENTIFY_MONTHLY_TOKEN_CAP || '0', 10);
  return cap > 0 ? cap : null; // 0/unset = no cap configured, unlimited
}

// Checked BEFORE every Haiku call -- refuses a NEW call once this
// month's (input+output) total has already reached the cap. A call
// already in flight when the cap is crossed is never interrupted.
async function isHaikuCapReached(prisma) {
  const cap = haikuCap();
  if (!cap) return false;
  const usage = await getMonthlyHaikuUsage(prisma);
  return (usage.inputTokens + usage.outputTokens) >= cap;
}

async function recordHaikuUsage(prisma, inputTokens, outputTokens) {
  const ym = currentYearMonth();
  await prisma.haikuUsage.upsert({
    where: { yearMonth: ym },
    create: { yearMonth: ym, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, callCount: 1 },
    update: {
      inputTokens: { increment: inputTokens || 0 },
      outputTokens: { increment: outputTokens || 0 },
      callCount: { increment: 1 },
    },
  });
}

module.exports = { currentYearMonth, getMonthlyHaikuUsage, haikuCap, isHaikuCapReached, recordHaikuUsage };

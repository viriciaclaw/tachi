const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_AMOUNT = MAX_SAFE_CENTS / 100;

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
  return cents / 100;
}

function roundCurrency(amount) {
  return fromCents(toCents(amount));
}

function isValidCurrencyAmount(value, { min = 0, allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }

  if (!Number.isSafeInteger(toCents(value))) {
    return false;
  }

  if (Math.abs(value) > MAX_SAFE_AMOUNT) {
    return false;
  }

  const rounded = roundCurrency(value);
  if (Math.abs(rounded - value) > Number.EPSILON) {
    return false;
  }

  if (allowZero && rounded === 0) {
    return true;
  }

  return rounded > min;
}

module.exports = {
  MAX_SAFE_AMOUNT,
  fromCents,
  isValidCurrencyAmount,
  roundCurrency,
  toCents,
};

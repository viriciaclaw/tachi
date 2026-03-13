const PII_PATTERNS = [
  {
    type: "private_key",
    replacement: "[REDACTED:private_key]",
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  {
    type: "jwt",
    replacement: "[REDACTED:jwt]",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  },
  {
    type: "connection_string",
    replacement: "[REDACTED:connection_string]",
    regex: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp):\/\/[^\s]+/g,
  },
  {
    type: "aws_key",
    replacement: "[REDACTED:aws_key]",
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    type: "api_key",
    replacement: "[REDACTED:api_key]",
    regex: /(?:sk-[A-Za-z0-9_-]{20,}|key-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|xoxb-[A-Za-z0-9-]+|xoxp-[A-Za-z0-9-]+)/g,
  },
  {
    type: "password",
    replacement: "[REDACTED:password]",
    regex: /\b(?:password|passwd|pwd|secret|token)\s*[=:]\s*[^\s,;]+/gi,
  },
  {
    type: "email",
    replacement: "[REDACTED:email]",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

function collectReplacement(text, pattern) {
  const detections = [];
  const masked = text.replace(pattern.regex, (match) => {
    detections.push({
      type: pattern.type,
      original: match,
      replacement: pattern.replacement,
    });
    return pattern.replacement;
  });

  return { masked, detections };
}

function maskPii(text) {
  if (!text) {
    return { masked: text, detections: [] };
  }

  let masked = text;
  const detections = [];

  for (const pattern of PII_PATTERNS) {
    const result = collectReplacement(masked, pattern);
    masked = result.masked;
    detections.push(...result.detections);
  }

  return { masked, detections };
}

module.exports = {
  maskPii,
};

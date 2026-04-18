function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector.slice();
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

const KEYWORDS = ["parallel", "route", "flow", "investor", "cost", "approval"];

function embedText(text) {
  const lower = String(text || "").toLowerCase();
  const vector = KEYWORDS.map((keyword) => (lower.includes(keyword) ? 1 : 0));
  return normalize(vector);
}

export default async function createEmbedder() {
  return async (input) => {
    const values = Array.isArray(input) ? input : [input];
    const rows = values.map((value) => embedText(value));
    return {
      dims: [rows.length, KEYWORDS.length],
      data: Float32Array.from(rows.flat())
    };
  };
}

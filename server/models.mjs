// Supplied catalog snapshot, 2026-10-24:
// https://tokenfactory.nebius.com/model-catalog.md
// https://docs.tokenfactory.nebius.com/quickstart.md
export const BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
export const MODELS = Object.freeze({
  nano: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  super: 'nvidia/nemotron-3-super-120b-a12b',
  ultra: 'nvidia/Nemotron-3-Ultra-550b-a55b',
});
export const PRICES = Object.freeze({
  [MODELS.nano]: { input: 0.06, output: 0.24 },
  [MODELS.super]: { input: 0.30, cached: 0.06, output: 0.90 },
  [MODELS.ultra]: { input: 1.00, cached: 0.12, output: 3.00 },
});

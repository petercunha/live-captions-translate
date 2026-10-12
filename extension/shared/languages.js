// Spoken languages, the speech engine that handles each one, and the
// translation targets offered in the UI.

// Moonshine model architectures (values of the engine's ModelArch enum).
export const ARCH = { tiny: 0, base: 1, tinyStreaming: 2, smallStreaming: 4, mediumStreaming: 5 };

// English uses Moonshine's streaming models; the size is a user setting.
export const EN_MODELS = {
  tiny: { label: 'Fastest (Tiny, 50 MB)', arch: ARCH.tinyStreaming },
  small: { label: 'Balanced (Small, 165 MB)', arch: ARCH.smallStreaming },
  medium: { label: 'Most accurate (Medium, 305 MB)', arch: ARCH.mediumStreaming },
};

// engine 'moonshine': on-device Moonshine model for that language (CPU/WASM).
// engine 'whisper': Whisper small (WebGPU), any language; `auto` detects it.
export const SPOKEN = [
  { code: 'en', name: 'English', engine: 'moonshine' },
  { code: 'es', name: 'Spanish', engine: 'moonshine', arch: ARCH.base },
  { code: 'zh', name: 'Chinese', engine: 'moonshine', arch: ARCH.base },
  { code: 'ja', name: 'Japanese', engine: 'moonshine', arch: ARCH.base },
  { code: 'ko', name: 'Korean', engine: 'moonshine', arch: ARCH.tiny },
  { code: 'ar', name: 'Arabic', engine: 'moonshine', arch: ARCH.base },
  { code: 'uk', name: 'Ukrainian', engine: 'moonshine', arch: ARCH.base },
  { code: 'vi', name: 'Vietnamese', engine: 'moonshine', arch: ARCH.base },
  { code: 'auto', name: 'Detect automatically', engine: 'whisper' },
  ...[
    ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['hi', 'Hindi'], ['tr', 'Turkish'], ['pl', 'Polish'], ['nl', 'Dutch'], ['id', 'Indonesian'],
    ['th', 'Thai'], ['sv', 'Swedish'], ['he', 'Hebrew'], ['el', 'Greek'], ['cs', 'Czech'],
    ['ro', 'Romanian'], ['hu', 'Hungarian'], ['da', 'Danish'], ['fi', 'Finnish'], ['no', 'Norwegian'],
    ['fa', 'Persian'], ['ms', 'Malay'], ['ta', 'Tamil'], ['bn', 'Bengali'], ['ur', 'Urdu'],
  ].map(([code, name]) => ({ code, name, engine: 'whisper' })),
];

// Languages Chrome's built-in Translator handles.
export const TARGETS = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['bn', 'Bengali'], ['vi', 'Vietnamese'], ['uk', 'Ukrainian'], ['pl', 'Polish'],
  ['nl', 'Dutch'], ['tr', 'Turkish'], ['id', 'Indonesian'], ['th', 'Thai'], ['sv', 'Swedish'],
  ['da', 'Danish'], ['fi', 'Finnish'], ['no', 'Norwegian'], ['cs', 'Czech'], ['el', 'Greek'],
  ['he', 'Hebrew'], ['hu', 'Hungarian'], ['ro', 'Romanian'], ['bg', 'Bulgarian'], ['hr', 'Croatian'],
  ['sk', 'Slovak'], ['lt', 'Lithuanian'], ['mr', 'Marathi'], ['ta', 'Tamil'], ['te', 'Telugu'],
  ['kn', 'Kannada'],
].map(([code, name]) => ({ code, name }));

export const DEFAULT_SETTINGS = {
  asrLang: 'en',
  enModel: 'small',
  target: 'es',
  showOriginal: true,
  fontSize: 'm',
};

export function spokenLanguage(code) {
  return SPOKEN.find((l) => l.code === code) ?? SPOKEN[0];
}

export function languageName(code) {
  return SPOKEN.find((l) => l.code === code)?.name ?? TARGETS.find((l) => l.code === code)?.name ?? code;
}

// 'en' matches 'en-US', but Simplified and Traditional Chinese differ.
export function sameLanguage(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const hant = (c) => /hant|tw|hk/i.test(c);
  return a.split('-')[0] === b.split('-')[0] && hant(a) === hant(b);
}

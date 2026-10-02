import { en } from '../src/i18n/en/index.js';
import { es } from '../src/i18n/es/index.js';
import { fr } from '../src/i18n/fr/index.js';
import { sw } from '../src/i18n/sw/index.js';
let failed = false;
for (const [lang, dict] of Object.entries({es,fr,sw})) {
  const missing = Object.keys(en).filter(key => !(key in dict));
  const placeholders = (s:string) => [...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');
  const mismatched = Object.keys(en).filter(key => key in dict && placeholders(en[key]) !== placeholders(dict[key]));
  if (missing.length || mismatched.length) {
    failed = true;
    console.error(`${lang}: missing ${missing.join(', ') || 'none'}; interpolation mismatch ${mismatched.join(', ') || 'none'}`);
  }
}
if (failed) process.exit(1);
console.log('i18n: all English keys and interpolation parameters covered by es/fr/sw');

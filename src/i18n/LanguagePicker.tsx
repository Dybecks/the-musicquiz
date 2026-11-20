import { LANGS, setLang, useLang, useT } from '.';

/** The EN / SV switch in the header. Each device keeps its own choice. */
export function LanguagePicker() {
  const lang = useLang();
  const t = useT();
  return (
    <div className="lang-picker" role="radiogroup" aria-label={t.app.language}>
      {LANGS.map((l) => (
        <button key={l.id} role="radio" aria-checked={lang === l.id} lang={l.id} title={l.name} className={lang === l.id ? 'selected' : ''} onClick={() => setLang(l.id)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

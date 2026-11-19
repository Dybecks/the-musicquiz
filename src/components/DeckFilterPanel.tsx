import { GENRES, sameFilter, type DeckFilter, type Genre, type Preset } from '../data/genres';

interface Props {
  filter: DeckFilter;
  onChange: (filter: DeckFilter) => void;
  presets: Preset[];
  personalPresets: Preset[];
  /** Songs left after filtering, and before. */
  count: number;
  total: number;
  /** Songs that come on top of the count once they are loaded, if any. */
  pending?: string;
  note?: string;
}

function parseYear(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : null;
}

export function DeckFilterPanel({ filter, onChange, presets, personalPresets, count, total, pending, note }: Props) {
  const toggleGenre = (g: Genre) =>
    onChange({ ...filter, genres: filter.genres.includes(g) ? filter.genres.filter((x) => x !== g) : [...filter.genres, g] });

  const presetButton = (p: Preset) => (
    <button
      key={p.id}
      className={`chip preset ${sameFilter(p.filter, filter) ? 'selected' : ''}`}
      aria-pressed={sameFilter(p.filter, filter)}
      onClick={() => onChange(p.filter)}
      title={p.detail}
    >
      <strong>{p.label}</strong>
      <span>{p.detail}</span>
    </button>
  );

  return (
    <section className="panel">
      <h2>Genres and years</h2>

      {personalPresets.length > 0 && (
        <>
          <p className="hint">Based on your music</p>
          <div className="chips">{personalPresets.map(presetButton)}</div>
        </>
      )}
      <p className="hint">Quick picks</p>
      <div className="chips">{presets.map(presetButton)}</div>

      <p className="hint">Genres {filter.genres.length === 0 && '(all)'}</p>
      <div className="chips" role="group" aria-label="Genres">
        {GENRES.map((g) => (
          <button
            key={g.id}
            className={`chip ${filter.genres.includes(g.id) ? 'selected' : ''}`}
            aria-pressed={filter.genres.includes(g.id)}
            onClick={() => toggleGenre(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="year-range">
        <label className="field">
          <span>From year</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="Any"
            value={filter.fromYear ?? ''}
            onChange={(e) => onChange({ ...filter, fromYear: parseYear(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>To year</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="Any"
            value={filter.toYear ?? ''}
            onChange={(e) => onChange({ ...filter, toYear: parseYear(e.target.value) })}
          />
        </label>
      </div>

      {note && <p className="hint">{note}</p>}
      {pending ? (
        <p className="hint">
          {count} of {total} songs match, {pending}.
        </p>
      ) : (
        <p className={count < 20 ? 'warn' : 'hint'}>
          {count} of {total} songs match.
          {count < 20 && ' That makes a short game; widen the genres or years for more.'}
        </p>
      )}
    </section>
  );
}

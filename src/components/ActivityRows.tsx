import type { AgentResponse } from "../types";
import { formatDate, levelLabel, relativeTime, verdictLabel } from "../lib/labels";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";

/** Operational rows: centro y motivo primero; la referencia queda como dato secundario copiable. */
export function ActivityRows({ entries, activeEventId, highlightedEventId, now, onSelect }: {
  entries: AgentResponse[];
  activeEventId: string;
  highlightedEventId: string;
  now: number;
  onSelect: (entry: AgentResponse, trigger: HTMLButtonElement) => void;
}) {
  return (
    <ul className="activityList">
      {entries.map((entry) => (
        <li className={`activityRow${entry.event_id === activeEventId ? " selected" : ""}${entry.event_id === highlightedEventId ? " isNew" : ""}`} key={entry.event_id}>
          <button className="activitySelect" type="button" aria-label={`Ver detalle del ingreso en ${entry.hospital || "centro sin registrar"}, ${relativeTime(entry.created_at, now)}`} aria-pressed={entry.event_id === activeEventId} onClick={(event) => onSelect(entry, event.currentTarget)}>
            <span className="activityIdentity">
              <strong className="activityTitle">{entry.hospital || "Centro no registrado"}</strong>
              {entry.reason && <span className="activityReason">{entry.reason}</span>}
              <small className="activityMeta" title={formatDate(entry.created_at)}>{relativeTime(entry.created_at, now)}{entry.maskedId ? ` · Asegurado ${entry.maskedId}` : ""}</small>
            </span>
            <span className="activityBadges">
              <span className="verdictTag">{verdictLabel(entry.verdict)}</span>
              <span className={`activityLevel ${entry.administrative_level}`}>{levelLabel(entry.administrative_level)}</span>
              {entry.reviewPending && <span className="reviewBadge">Revisión pendiente</span>}
            </span>
            <span className="activityOpen">Ver detalle <Icon name="arrow" size={13} /></span>
          </button>
          <div className="activityRef"><code>{entry.event_id}</code><CopyButton value={entry.event_id} label="Copiar referencia" compact /></div>
        </li>
      ))}
    </ul>
  );
}

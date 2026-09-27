import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityRows } from "../components/ActivityRows";
import { Icon } from "../components/Icon";
import { Select } from "../components/Pickers";
import { PanelHeading } from "../components/ResultPanel";
import { BackendConnectionError, loadIngressList } from "../lib/agentApi";
import { formatCount, relativeTime } from "../lib/labels";
import type { AdministrativeVerdict, AgentResponse, AlertLevel, IngressListFilters } from "../types";

const PAGE_SIZE = 20;
const REFRESH_MS = 60_000;

type Period = "" | "hoy" | "7d" | "30d";
interface FilterState { q: string; verdict: AdministrativeVerdict | ""; level: AlertLevel | ""; review: "" | "pendiente"; period: Period }

const VERDICT_OPTIONS: { value: AdministrativeVerdict | ""; label: string }[] = [
  { value: "", label: "Resultado" },
  { value: "VALIDA", label: "Válida" },
  { value: "VALIDA_CON_ALERTAS", label: "Válida con alertas" },
  { value: "NO_VALIDA", label: "No vigente" },
  { value: "NO_ENCONTRADO", label: "No encontrado" },
  { value: "PENDIENTE", label: "Pendiente" },
];
const LEVEL_OPTIONS: { value: AlertLevel | ""; label: string }[] = [
  { value: "", label: "Nivel" },
  { value: "prioritaria", label: "Prioridad administrativa" },
  { value: "revision", label: "Revisión administrativa" },
  { value: "informativa", label: "Aviso administrativo" },
];
const REVIEW_OPTIONS = [{ value: "", label: "Revisión" }, { value: "pendiente", label: "Revisión pendiente" }];
const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "", label: "Fecha" },
  { value: "hoy", label: "Hoy" },
  { value: "7d", label: "Últimos 7 días" },
  { value: "30d", label: "Últimos 30 días" },
];

export function filtersFromSearch(search: string): FilterState {
  const params = new URLSearchParams(search);
  const verdict = params.get("veredicto") ?? "";
  const level = params.get("nivel") ?? "";
  const period = params.get("periodo") ?? "";
  return {
    q: params.get("q") ?? "",
    verdict: VERDICT_OPTIONS.some((option) => option.value === verdict) ? verdict as AdministrativeVerdict | "" : "",
    level: LEVEL_OPTIONS.some((option) => option.value === level) ? level as AlertLevel | "" : "",
    review: params.get("revision") === "pendiente" ? "pendiente" : "",
    period: PERIOD_OPTIONS.some((option) => option.value === period) ? period as Period : "",
  };
}

function searchFromFilters(filters: FilterState) {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.verdict) params.set("veredicto", filters.verdict);
  if (filters.level) params.set("nivel", filters.level);
  if (filters.review) params.set("revision", filters.review);
  if (filters.period) params.set("periodo", filters.period);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function apiFilters(filters: FilterState): IngressListFilters {
  let from: string | undefined;
  if (filters.period) {
    const start = new Date();
    if (filters.period === "hoy") start.setHours(0, 0, 0, 0);
    else start.setDate(start.getDate() - (filters.period === "7d" ? 7 : 30));
    from = start.toISOString();
  }
  return {
    q: filters.q,
    verdict: filters.verdict ? [filters.verdict] : undefined,
    level: filters.level ? [filters.level] : undefined,
    pendingReview: filters.review === "pendiente",
    from,
  };
}

const hasFilters = (filters: FilterState) => Boolean(filters.q.trim() || filters.verdict || filters.level || filters.review || filters.period);

export function ActivityPage({ canRead, refreshKey, activeEventId, highlightedEventId, onSelect, onConnection }: {
  canRead: boolean;
  refreshKey: number;
  activeEventId: string;
  highlightedEventId: string;
  onSelect: (entry: AgentResponse, trigger: HTMLButtonElement) => void;
  onConnection: (online: boolean) => void;
}) {
  const [filters, setFilters] = useState<FilterState>(() => filtersFromSearch(window.location.search));
  const [query, setQuery] = useState(filters.q);
  const [items, setItems] = useState<AgentResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(canRead);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [newCount, setNewCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const requestRef = useRef(0);
  const topRef = useRef<AgentResponse | undefined>(undefined);
  topRef.current = items[0];

  // Keep the URL shareable and in sync with the visible filters.
  useEffect(() => {
    const next = `${window.location.pathname}${searchFromFilters(filters)}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, "", next);
  }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => current.q === query ? current : { ...current, q: query }), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    if (!canRead) return;
    const requestId = ++requestRef.current;
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await loadIngressList(apiFilters(filters), nextPage, PAGE_SIZE);
      if (requestId !== requestRef.current) return;
      setItems((current) => append ? [...current, ...result.items.filter((item) => !current.some((existing) => existing.event_id === item.event_id))] : result.items);
      setTotal(result.total);
      setPage(nextPage);
      setNewCount(0);
      setUpdatedAt(Date.now());
      onConnection(true);
    } catch (loadError) {
      if (requestId !== requestRef.current) return;
      if (loadError instanceof BackendConnectionError) onConnection(false);
      setError(loadError instanceof Error ? loadError.message : "No se pudo consultar la actividad.");
    } finally {
      if (requestId === requestRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [canRead, filters, onConnection]);

  useEffect(() => { void load(1, false); }, [load, refreshKey]);

  // Background check: announce new entries instead of moving the list under the reader.
  useEffect(() => {
    if (!canRead) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState !== "visible") return;
      void loadIngressList(apiFilters(filters), 1, PAGE_SIZE).then((result) => {
        const top = topRef.current;
        if (!top) {
          if (result.items.length) void load(1, false);
          return;
        }
        const topTime = Date.parse(top.created_at ?? "") || 0;
        setNewCount(result.items.filter((item) => item.event_id !== top.event_id && (Date.parse(item.created_at ?? "") || 0) >= topTime).length);
        onConnection(true);
      }).catch(() => undefined);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [canRead, filters, load, onConnection]);

  function patch(next: Partial<FilterState>) {
    setFilters((current) => ({ ...current, ...next }));
  }

  function clearFilters() {
    setQuery("");
    setFilters({ q: "", verdict: "", level: "", review: "", period: "" });
  }

  const filtered = hasFilters(filters);
  const emptyText = error
    ? "No se pudo cargar la actividad."
    : loading
      ? "Consultando los ingresos…"
      : filtered ? "Ningún ingreso coincide con estos filtros." : "Todavía no hay ingresos registrados.";

  return (
    <div className="clientPageStack">
      <header className="pageIntro clientPageIntro"><span className="eyebrow">SEGUIMIENTO DE INGRESOS</span><h1>Actividad</h1><p>Busca y filtra los ingresos recibidos por el servicio, y abre su detalle administrativo.</p></header>
      <section className="glassPanel activityPanel" aria-busy={loading} aria-label="Historial de ingresos">
        <div className="activityHeading">
          <div>
            <PanelHeading eyebrow="REGISTRO DE EVENTOS" title={filtered ? "Resultados filtrados" : "Todos los ingresos"} />
            <p>{canRead ? updatedAt ? `Actualizado ${relativeTime(new Date(updatedAt).toISOString(), now)} · se revisa cada minuto` : "Registros recibidos por el servicio de Vigilia." : "Tu perfil no tiene permiso para consultar el historial de ingresos."}</p>
          </div>
          <div className="activityActions">
            <span className="activityCount">{loading ? "…" : `${formatCount(total)} ${total === 1 ? "ingreso" : "ingresos"}`}</span>
            <button className="historyRefresh" type="button" onClick={() => void load(1, false)} disabled={loading || !canRead}><Icon name="refresh" size={13} />{loading ? "Actualizando…" : "Actualizar"}</button>
          </div>
        </div>

        {canRead && <div className="activityToolbar" role="search">
          <label className="toolbarSearch"><Icon name="search" size={15} /><span className="srOnly">Buscar</span><input autoComplete="off" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por centro, motivo, referencia o identificación" maxLength={80} /></label>
          <label className="toolbarSelect"><span className="srOnly">Resultado</span><Select value={filters.verdict} onChange={(verdict) => patch({ verdict: verdict as FilterState["verdict"] })} options={VERDICT_OPTIONS} /></label>
          <label className="toolbarSelect"><span className="srOnly">Nivel</span><Select value={filters.level} onChange={(level) => patch({ level: level as FilterState["level"] })} options={LEVEL_OPTIONS} /></label>
          <label className="toolbarSelect"><span className="srOnly">Revisión</span><Select value={filters.review} onChange={(review) => patch({ review: review as FilterState["review"] })} options={REVIEW_OPTIONS} /></label>
          <label className="toolbarSelect"><span className="srOnly">Periodo</span><Select value={filters.period} onChange={(period) => patch({ period: period as Period })} options={PERIOD_OPTIONS} /></label>
          {filtered && <button className="textAction toolbarClear" type="button" onClick={clearFilters}>Limpiar filtros</button>}
        </div>}

        {newCount > 0 && <button className="newEntriesPill" type="button" onClick={() => void load(1, false)}><Icon name="arrow" size={13} />{newCount === 1 ? "1 ingreso nuevo" : `${newCount} ingresos nuevos`} · Mostrar</button>}
        {error && <p className="activityError" role="alert">{error}</p>}
        {items.length > 0
          ? <ActivityRows entries={items} activeEventId={activeEventId} highlightedEventId={highlightedEventId} now={now} onSelect={onSelect} />
          : <div className="activityEmpty"><span className="hintDot" /><span>{canRead ? emptyText : "Pide a un administrador el permiso de consulta de ingresos."}</span></div>}
        {items.length > 0 && items.length < total && <div className="activityMore">
          <span>Mostrando {formatCount(items.length)} de {formatCount(total)}</span>
          <button className="secondaryButton" type="button" onClick={() => void load(page + 1, true)} disabled={loadingMore}>{loadingMore ? "Cargando…" : "Cargar más"}</button>
        </div>}
      </section>
    </div>
  );
}

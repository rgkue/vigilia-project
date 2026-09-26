import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import vigiliaCardNavLogo from "../assets/vigilia-card-nav-logo.svg";

export type NavLink = { label: string; href: string; active: boolean; badge?: string; ariaLabel?: string };
export type NavGroup = { label: string; links: NavLink[] };
export type NavAccount = {
  name: string;
  roleLabel: string;
  identifier: string;
  logoutPending: boolean;
  /** Sin gafete (por ejemplo, la cuenta del modo Demo) no se muestra la opción. */
  onBadge?: () => void;
  /** Solo para cuentas de Vigilia con contraseña. */
  onChangePassword?: () => void;
  onSignOut: () => void;
};

type CardNavProps = {
  groups: NavGroup[];
  sectionLabel: string;
  status: string;
  statusTone: string;
  showIntakeCta: boolean;
  intakeActive: boolean;
  account?: NavAccount;
  onNavigate: (href: string) => void;
};

const CARD_COLORS = ["rgba(52,52,55,.96)", "rgba(42,42,45,.96)", "rgba(34,34,37,.96)", "rgba(28,39,35,.96)"];
const ACCOUNT_COLOR = "rgba(25,45,39,.96)";
const COLLAPSED = 60;

function ArrowUpRight() {
  return <svg aria-hidden="true" className="nav-card-link-icon" width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 17 17 7M8 7h9v9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CardNav({ groups, sectionLabel, status, statusTone, showIntakeCta, intakeActive, account, onNavigate }: CardNavProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedHeight, setExpandedHeight] = useState(COLLAPSED);
  const navRef = useRef<HTMLElement | null>(null);

  const calculateHeight = () => {
    const navEl = navRef.current;
    const contentEl = navEl?.querySelector<HTMLElement>(".card-nav-content");
    if (!navEl || !contentEl) return 260;
    const mobile = window.matchMedia("(max-width: 768px)").matches;
    const previous = {
      visibility: contentEl.style.visibility,
      pointerEvents: contentEl.style.pointerEvents,
      position: contentEl.style.position,
      height: contentEl.style.height,
    };
    contentEl.style.visibility = "visible";
    contentEl.style.pointerEvents = "auto";
    contentEl.style.position = "static";
    contentEl.style.height = "auto";
    void contentEl.offsetHeight;
    const contentHeight = contentEl.scrollHeight;
    contentEl.style.visibility = previous.visibility;
    contentEl.style.pointerEvents = previous.pointerEvents;
    contentEl.style.position = previous.position;
    contentEl.style.height = previous.height;
    return mobile ? COLLAPSED + contentHeight + 16 : Math.max(260, COLLAPSED + contentHeight + 8);
  };

  useLayoutEffect(() => {
    if (isExpanded) setExpandedHeight(calculateHeight());
  }, [isExpanded, groups.length, account?.name]);

  useEffect(() => {
    if (!isExpanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const recalculateOnResize = () => setExpandedHeight(calculateHeight());
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", recalculateOnResize);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", recalculateOnResize);
    };
  }, [isExpanded]);

  function toggleMenu() {
    if (isExpanded) {
      closeMenu();
      return;
    }
    setExpandedHeight(calculateHeight());
    setIsExpanded(true);
  }

  function closeMenu() {
    setExpandedHeight(COLLAPSED);
    setIsExpanded(false);
  }

  function navigate(href: string, event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onNavigate(href);
    closeMenu();
  }

  return (
    <div className="card-nav-container">
      <nav
        ref={navRef}
        aria-label={`Navegación principal de Vigilia. ${status}`}
        data-backend-status={statusTone}
        className={`card-nav${isExpanded ? " open" : ""}`}
        style={{ backgroundColor: "rgba(20,20,22,.76)", height: `${expandedHeight}px` }}
      >
        <div className="card-nav-top">
          <div className="card-nav-start">
            <button
              type="button"
              className={`hamburger-menu${isExpanded ? " open" : ""}`}
              onClick={toggleMenu}
              aria-label={isExpanded ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={isExpanded}
              aria-controls="vigilia-navigation-cards"
            >
              <span className="hamburger-line" />
              <span className="hamburger-line" />
            </button>
            <span className="card-nav-section" aria-hidden="true">{sectionLabel}</span>
          </div>

          <a className="logo-container" href="/resumen" aria-label="Vigilia, resumen" title={status} onClick={(event) => navigate("/resumen", event)}>
            <img src={vigiliaCardNavLogo} alt="Vigilia" className="logo" />
          </a>

          <div className="card-nav-end">
            {showIntakeCta && <a
              className="card-nav-cta-button"
              href="/ingreso"
              aria-current={intakeActive ? "location" : undefined}
              aria-label="Registrar ingreso"
              title="Registrar ingreso"
              onClick={(event) => navigate("/ingreso", event)}
            >
              <svg className="card-nav-cta-icon" aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" focusable="false">
                <path d="M8 4.5h8a2 2 0 0 1 2 2v13H6v-13a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                <path d="M9 4.5V3.7A1.7 1.7 0 0 1 10.7 2h2.6A1.7 1.7 0 0 1 15 3.7v.8M12 9v6m-3-3h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="card-nav-cta-label">Registrar ingreso</span>
            </a>}
          </div>
        </div>

        <div className="card-nav-content" id="vigilia-navigation-cards" aria-hidden={!isExpanded} inert={!isExpanded}>
          {groups.map((group, index) => (
            <div
              key={group.label}
              className="nav-card"
              style={{ backgroundColor: CARD_COLORS[index % CARD_COLORS.length], color: "#f5f5f7", transitionDelay: isExpanded ? `${index * 80}ms` : "0ms" }}
            >
              <div className="nav-card-label">{group.label}</div>
              <div className="nav-card-links">
                {group.links.map((link) => (
                  <a
                    key={link.href}
                    className="nav-card-link"
                    href={link.href}
                    aria-label={link.ariaLabel}
                    aria-current={link.active ? "page" : undefined}
                    onClick={(event) => navigate(link.href, event)}
                  >
                    <ArrowUpRight />
                    {link.label}
                    {link.badge && <span className="nav-card-badge">{link.badge}</span>}
                  </a>
                ))}
              </div>
            </div>
          ))}
          {account && <section className="nav-card nav-account-card" aria-label="Cuenta" style={{ backgroundColor: ACCOUNT_COLOR, color: "#f5f5f7", transitionDelay: isExpanded ? `${groups.length * 80}ms` : "0ms" }}>
            <div className="nav-card-label">Cuenta</div>
            <span className="nav-account-name">{account.name}</span>
            <span className="nav-account-email">{account.roleLabel} · {account.identifier}</span>
            <div className="nav-card-links">
              {account.onBadge && <button className="nav-card-link nav-account-logout" type="button" onClick={() => { closeMenu(); account.onBadge?.(); }}><ArrowUpRight />Mi gafete QR</button>}
              {account.onChangePassword && <button className="nav-card-link nav-account-logout" type="button" onClick={() => { closeMenu(); account.onChangePassword?.(); }}><ArrowUpRight />Cambiar contraseña</button>}
              <button className="nav-card-link nav-account-logout" type="button" onClick={() => { account.onSignOut(); closeMenu(); }} disabled={account.logoutPending}>{account.logoutPending ? "Cerrando sesión…" : "Cerrar sesión"}</button>
            </div>
          </section>}
        </div>
      </nav>
    </div>
  );
}

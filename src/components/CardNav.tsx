import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import vigiliaCardNavLogo from "../assets/vigilia-card-nav-logo.svg";

type SectionId = "overview" | "intake" | "activity";
type RouteHref = "/resumen" | "/ingreso" | "/actividad";
type CardNavProps = { activeSection: SectionId; status: string; statusTone: string; onNavigate: (href: RouteHref) => void };

type CardLink = { label: string; href: RouteHref; section: SectionId; ariaLabel: string };
type CardItem = { label: string; bgColor: string; textColor: string; links: CardLink[] };

const items: CardItem[] = [
  {
    label: "Centro",
    bgColor: "rgba(52,52,55,.96)",
    textColor: "#f5f5f7",
    links: [{ label: "Vista general", href: "/resumen", section: "overview", ariaLabel: "Abrir la página de resumen de Vigilia" }],
  },
  {
    label: "Registro",
    bgColor: "rgba(42,42,45,.96)",
    textColor: "#f5f5f7",
      links: [{ label: "Registrar ingreso", href: "/ingreso", section: "intake", ariaLabel: "Abrir el formulario para registrar un ingreso" }],
  },
  {
    label: "Seguimiento",
    bgColor: "rgba(34,34,37,.96)",
    textColor: "#f5f5f7",
    links: [{ label: "Actividad reciente", href: "/actividad", section: "activity", ariaLabel: "Abrir la página de actividad reciente" }],
  },
];

function ArrowUpRight() {
  return <svg aria-hidden="true" className="nav-card-link-icon" width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 17 17 7M8 7h9v9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CardNav({ activeSection, status, statusTone, onNavigate }: CardNavProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedHeight, setExpandedHeight] = useState(60);
  const navRef = useRef<HTMLElement | null>(null);

  const calculateHeight = () => {
    const navEl = navRef.current;
    if (!navEl) return 260;

    if (window.matchMedia("(max-width: 768px)").matches) {
      const contentEl = navEl.querySelector<HTMLElement>(".card-nav-content");
      if (contentEl) {
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
        contentEl.offsetHeight;
        const contentHeight = contentEl.scrollHeight;

        contentEl.style.visibility = previous.visibility;
        contentEl.style.pointerEvents = previous.pointerEvents;
        contentEl.style.position = previous.position;
        contentEl.style.height = previous.height;

        return 60 + contentHeight + 16;
      }
    }

    return 260;
  };

  useLayoutEffect(() => {
    if (isExpanded) setExpandedHeight(calculateHeight());
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpandedHeight(60);
        setIsExpanded(false);
      }
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
      setExpandedHeight(60);
      setIsExpanded(false);
      return;
    }

    setExpandedHeight(calculateHeight());
    setIsExpanded(true);
  }

  function closeMenu() {
    setExpandedHeight(60);
    setIsExpanded(false);
  }

  function navigate(href: RouteHref, event: MouseEvent<HTMLAnchorElement>) {
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

          <a className="logo-container" href="/resumen" aria-label="Vigilia, resumen" title={status} onClick={(event) => navigate("/resumen", event)}>
            <img src={vigiliaCardNavLogo} alt="Vigilia" className="logo" />
          </a>

          <a
            className="card-nav-cta-button"
            href="/ingreso"
            aria-current={activeSection === "intake" ? "location" : undefined}
            onClick={(event) => navigate("/ingreso", event)}
          >
            Registrar ingreso
          </a>
        </div>

        <div className="card-nav-content" id="vigilia-navigation-cards" aria-hidden={!isExpanded} inert={!isExpanded}>
          {items.slice(0, 3).map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              className="nav-card"
              style={{ backgroundColor: item.bgColor, color: item.textColor, transitionDelay: isExpanded ? `${index * 80}ms` : "0ms" }}
            >
              <div className="nav-card-label">{item.label}</div>
              <div className="nav-card-links">
                {item.links.map((link) => (
                  <a
                    key={link.href}
                    className="nav-card-link"
                    href={link.href}
                    aria-label={link.ariaLabel}
                    aria-current={activeSection === link.section ? "page" : undefined}
                    onClick={(event) => navigate(link.href, event)}
                  >
                    <ArrowUpRight />
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}

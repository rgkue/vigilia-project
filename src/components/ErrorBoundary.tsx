import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keeps a rendering failure inside the page frame instead of leaving a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Vigilia UI error", error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="glassPanel pageErrorPanel" role="alert">
        <div className="errorBanner">
          <span className="errorMark">!</span>
          <div>
            <strong>Esta sección no se pudo mostrar</strong>
            <p>El resto de Vigilia sigue disponible. Recarga la página; si vuelve a ocurrir, avisa al administrador de la instalación.</p>
            <button className="secondaryButton" type="button" onClick={() => window.location.reload()}>Recargar página</button>
          </div>
        </div>
      </section>
    );
  }
}

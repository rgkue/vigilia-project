import { Icon } from "../components/Icon";

export function NotFoundPage({ onHome }: { onHome: () => void }) {
  return (
    <div className="clientPageStack">
      <header className="pageIntro clientPageIntro">
        <span className="eyebrow">PÁGINA NO ENCONTRADA</span>
        <h1>Esta dirección no existe</h1>
        <p>Es posible que el enlace esté incompleto o que la sección haya cambiado de lugar. Tus datos no se vieron afectados.</p>
      </header>
      <div><button className="primaryButton" type="button" onClick={onHome}>Ir al resumen <Icon name="arrow" size={16} /></button></div>
    </div>
  );
}

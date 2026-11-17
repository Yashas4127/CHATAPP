const COLORS = ["#6c8cff", "#ff7aa8", "#43c6a4", "#f5a65b", "#a78bfa", "#4cc3f0", "#e8727a", "#8fc95a"];

export function Avatar({ name = "?", size = 38 }) {
  const hash = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <span className="avatar" style={{ width: size, height: size, background: COLORS[hash % COLORS.length], fontSize: size * 0.42 }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

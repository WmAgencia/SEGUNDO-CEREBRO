import { Link, useLocation } from "react-router-dom";
import styles from "./Sidebar.module.css";

export default function Sidebar() {
  const loc = useLocation();
  const items = [
    { path: "/projects", label: "Projetos", icon: "▣" },
    { path: "/editor", label: "Editor", icon: "▶" },
    { path: "/clips", label: "Clips", icon: "◢" },
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.logo}>●</div>
        <div>
          <div className={styles.brandName}>CLIPCON</div>
          <div className={styles.brandSub}>v0.1 · AI Editor</div>
        </div>
      </div>

      <nav className={styles.nav}>
        {items.map((it) => {
          const active = loc.pathname.startsWith(it.path);
          return (
            <Link
              key={it.path}
              to={it.path}
              className={`${styles.navItem} ${active ? styles.active : ""}`}
            >
              <span className={styles.icon}>{it.icon}</span>
              <span>{it.label}</span>
              {active && <span className={styles.activeBar} />}
            </Link>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <div className={styles.statusDot} />
        <div className={styles.statusText}>
          <div>NEXXUS PRO</div>
          <div className={styles.statusDim}>online</div>
        </div>
      </div>
    </aside>
  );
}

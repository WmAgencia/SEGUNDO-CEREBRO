import { useLocation } from "react-router-dom";
import styles from "./Topbar.module.css";

const TITLES: Record<string, string> = {
  "/projects": "Projetos",
  "/editor": "Editor de Vídeo",
  "/clips": "Clips · Criador de Cortes",
};

export default function Topbar() {
  const loc = useLocation();
  const base = "/" + (loc.pathname.split("/")[1] || "projects");
  const title = TITLES[base] || "ClipCon";

  return (
    <header className={styles.topbar}>
      <div className={styles.crumbs}>
        <span className={styles.crumb}>~</span>
        <span className={styles.crumb}>clipcon</span>
        <span className={styles.sep}>/</span>
        <span className={`${styles.crumb} ${styles.active}`}>{title}</span>
      </div>
      <div className={styles.right}>
        <span className={styles.tag}>NEXUS-AI</span>
        <span className={styles.time}>{new Date().toLocaleTimeString("pt-BR")}</span>
      </div>
    </header>
  );
}

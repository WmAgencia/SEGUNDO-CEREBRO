import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import MatrixBg from "./MatrixBg";
import styles from "./AppShell.module.css";

export default function AppShell() {
  const scanRef = useRef<HTMLDivElement>(null);

  // Scanline effect (animação leve)
  useEffect(() => {
    const el = scanRef.current;
    if (!el) return;
    let frame = 0;
    let raf: number;
    const tick = () => {
      frame++;
      el.style.transform = `translateY(${(frame % 100) * 6}vh)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={styles.shell}>
      <MatrixBg />
      <div className={styles.layout}>
        <Sidebar />
        <div className={styles.main}>
          <Topbar />
          <main className={styles.content}>
            <Outlet />
          </main>
        </div>
      </div>
      <div className={styles.scanlines} />
      <div ref={scanRef} className={styles.scanLine} />
    </div>
  );
}

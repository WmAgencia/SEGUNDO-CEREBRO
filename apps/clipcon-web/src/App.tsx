import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./shell/AppShell";
import ProjectsPage from "./projects/ProjectsPage";
import EditorPage from "./editor/EditorPage";
import ClipsPage from "./clips/ClipsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectsPage />} />
        <Route path="/editor/:projectId" element={<EditorPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/clips/:projectId" element={<ClipsPage />} />
        <Route path="/clips" element={<ClipsPage />} />
      </Route>
    </Routes>
  );
}

// app.jsx — App shell with hash-based routing
// Loaded last; Cockpit and InputsForm are exposed on window by their files.

const { useState, useEffect } = React;

const App = () => {
  const [route, setRoute] = useState(window.location.hash || "#cockpit");

  useEffect(() => {
    const handler = () => setRoute(window.location.hash || "#cockpit");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const CockpitView  = window.Cockpit;
  const InputsView   = window.InputsForm;

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">
          Axiom <span>Drawing Flow</span>
        </div>
        <div className="nav-links">
          <a href="#cockpit" className={route === "#cockpit" ? "active" : ""}>
            Cockpit
          </a>
          <a href="#inputs" className={route === "#inputs" ? "active" : ""}>
            Programme Inputs
          </a>
        </div>
      </nav>
      <main>
        {route === "#inputs"
          ? <InputsView />
          : <CockpitView />
        }
      </main>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

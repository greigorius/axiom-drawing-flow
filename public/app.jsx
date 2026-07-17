// app.jsx — App shell with hash-based routing
// Loaded last; Cockpit and ActivityFeed are exposed on window by their files.

const { useState, useEffect } = React;

const App = () => {
  const [route, setRoute] = useState(window.location.hash || "#cockpit");

  useEffect(() => {
    const handler = () => setRoute(window.location.hash || "#cockpit");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const CockpitView = window.Cockpit;
  const FeedView     = window.ActivityFeed;

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
          <a href="#activity" className={route === "#activity" ? "active" : ""}>
            Activity Feed
          </a>
        </div>
      </nav>
      <main>
        {route === "#activity"
          ? <FeedView />
          : <CockpitView />
        }
      </main>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

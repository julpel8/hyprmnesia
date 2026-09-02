import { useEffect } from 'react'
import { ping } from './api'
import { navigate, useRoute } from './router'
import { LiveView } from './views/LiveView'
import { ReplayView } from './views/ReplayView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { StatusView } from './views/StatusView'

interface NavItem {
  path: string
  label: string
}

const NAV: NavItem[] = [
  { path: '/status', label: 'Dashboard' },
  { path: '/replay', label: 'Replay' },
  { path: '/search', label: 'Search' },
  { path: '/live', label: 'Live' },
  { path: '/settings', label: 'Settings' },
]

export function App() {
  const route = useRoute()

  // Keep the ephemeral server alive while this tab is open.
  useEffect(() => {
    ping()
    const timer = window.setInterval(ping, 2000)
    return () => window.clearInterval(timer)
  }, [])

  let view: React.ReactNode
  switch (route.path) {
    case '/replay':
      view = <ReplayView params={route.params} />
      break
    case '/status':
      view = <StatusView />
      break
    case '/search':
      view = <SearchView />
      break
    case '/live':
      view = <LiveView />
      break
    case '/settings':
      view = <SettingsView />
      break
    default:
      view = <ReplayView params={route.params} />
  }

  return (
    <div className="shell">
      <nav className="nav">
        {NAV.map((item) => (
          <button
            type="button"
            key={item.path}
            className={route.path === item.path ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate(item.path)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main className="content">{view}</main>
    </div>
  )
}

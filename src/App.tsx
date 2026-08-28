import React, { lazy, Suspense } from 'react'
import { Route, Switch } from 'wouter'
import PhotoWall from './components/PhotoWall'
import { MotionConfig } from 'motion/react'

const Admin = lazy(() => import('./components/Admin'))
const Login = lazy(() => import('./components/Login'))
const Security = lazy(() => import('./components/Security'))

class RouteBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() {
    return this.state.failed ? <main role="alert"><p>Could not load this page.</p>
      <button onClick={() => window.location.reload()}>Reload page</button></main> : this.props.children
  }
}

function App() {
  return (
    <RouteBoundary><Suspense fallback={<p role="status">Loading page…</p>}>
      <Switch>
        <Route path="/">
          <MotionConfig transition={{ duration: 0.16 }}>
            <PhotoWall />
          </MotionConfig>
        </Route>
        <Route path="/admin">
          <Admin />
        </Route>
        <Route path="/login"><Login /></Route>
        <Route path="/admin/security"><Security /></Route>
        <Route>404 Not Found</Route>
      </Switch>
    </Suspense></RouteBoundary>
  )
}

export default App

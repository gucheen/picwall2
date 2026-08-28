import React from 'react'
import { Route, Switch } from 'wouter'
import PhotoWall from './components/PhotoWall'
import Admin from './components/Admin'
import Login from './components/Login'
import Security from './components/Security'
import { MotionConfig } from 'motion/react'

function App() {
  return (
    <>
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
    </>
  )
}

export default App

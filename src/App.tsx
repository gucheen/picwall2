import React from 'react'
import { Route, Switch } from 'wouter'
import PhotoWall from './components/PhotoWall'
import Admin from './components/Admin'


function App() {

  return (
    <>
      <Switch>
        <Route path="/">
          <PhotoWall />
        </Route>
        <Route path="/admin">
          <Admin />
        </Route>
        <Route>
          404 Not Found
        </Route>
      </Switch>
    </>
  )
}

export default App

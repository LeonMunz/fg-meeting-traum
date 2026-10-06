import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'

import { DataRouterApp } from './app/App'
import { appRoutes } from './app/routes'
import './index.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element not found')
}

const router = createBrowserRouter(appRoutes)

createRoot(root).render(
  <StrictMode>
    <DataRouterApp router={router} />
  </StrictMode>,
)

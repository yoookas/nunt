import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'
import './index.css'
import './charts.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { AuthProvider } from './session'
import { ThemeProvider } from './theme'
import { router } from './router'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)

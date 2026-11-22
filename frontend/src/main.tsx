import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { Toast } from '@heroui/react'
import './index.css'
import router from './router'
import { AuthProvider } from './session'
import { ThemeProvider } from './theme'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toast.Provider />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)

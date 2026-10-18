import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import AuthPage from './pages/AuthPages'
import Workspace from './pages/RoleDashboard'

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading-screen"><span className="loader"/> Preparing your workspace…</div>
  return user ? children : <Navigate to="/login" replace />
}

function RouterView() {
  const { user } = useAuth()
  return <Routes>
    <Route path="/" element={<Navigate to={user ? '/app' : '/login'} replace />} />
    <Route path="/login" element={<AuthPage mode="login"/>}/>
    <Route path="/register" element={<AuthPage mode="register"/>}/>
    <Route path="/forgot-password" element={<AuthPage mode="forgot"/>}/>
    <Route path="/reset-password" element={<AuthPage mode="reset"/>}/>
    <Route path="/app" element={<Protected><Workspace/></Protected>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes>
}

export default function App() { return <AuthProvider><RouterView/></AuthProvider> }

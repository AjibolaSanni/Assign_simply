import { GraduationCap } from 'lucide-react'

export default function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><GraduationCap size={22} strokeWidth={2.2} /></span><span>Assign<span className="brand-accent">Simply</span></span></div>
}

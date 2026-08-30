import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorFallback } from './ExperienceUI'

interface Props {
  children: ReactNode
}

interface State {
  message?: string
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : '未知渲染错误' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Book Galaxy render failure', error, info.componentStack)
  }

  render() {
    if (this.state.message) {
      return <ErrorFallback message={this.state.message} onReset={() => window.location.reload()} />
    }
    return this.props.children
  }
}

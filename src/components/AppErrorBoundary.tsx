import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorFallback } from './ExperienceUI'

interface Props {
  children: ReactNode
}

interface State {
  message?: string
}

const PUBLIC_RENDER_FAILURE_MESSAGE = '星海暂时失去显影，请刷新页面后重试。'

export class AppErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { message: PUBLIC_RENDER_FAILURE_MESSAGE }
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

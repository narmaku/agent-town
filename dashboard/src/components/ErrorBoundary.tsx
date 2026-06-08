import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleDismiss = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <h2 className="error-boundary-title">Something went wrong</h2>
            <p className="error-boundary-message">
              The dashboard encountered an unexpected error. This can happen when a remote machine disconnects.
            </p>
            {this.state.error && <pre className="error-boundary-detail">{this.state.error.message}</pre>}
            <div className="error-boundary-actions">
              <button type="button" className="send-btn" onClick={this.handleReload} aria-label="Reload the dashboard">
                Reload
              </button>
              <button
                type="button"
                className="action-btn"
                onClick={this.handleDismiss}
                aria-label="Dismiss error and try to recover"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

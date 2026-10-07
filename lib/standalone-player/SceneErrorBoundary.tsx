import { Component, type ReactNode } from 'react';
import { UnavailableScene } from './scenes/UnavailableScene';

/**
 * Contains a scene that fails to render: the scene shows as unavailable and
 * the rest of the classroom stays navigable. Keyed per scene by the caller,
 * so moving to another scene starts from a clean state.
 */
export class SceneErrorBoundary extends Component<
  { message: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Scene failed to render', error);
  }

  render() {
    return this.state.failed ? (
      <UnavailableScene message={this.props.message} />
    ) : (
      this.props.children
    );
  }
}

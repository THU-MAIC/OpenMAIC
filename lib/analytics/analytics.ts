/**
 * Client-side analytics service for tracking user engagement.
 * Methods are designed to be "fire-and-forget".
 */

export interface AnalyticsEvent {
  type: 'course_view' | 'slide_view' | 'heartbeat';
  courseId: string;
  courseName?: string;
  slideIndex?: number;
  totalSlides?: number;
  durationSeconds?: number;
}

export interface QuizSubmission {
  courseId: string;
  sceneId: string;
  score: number;
  totalPoints: number;
  displayName?: string;
  avatarUrl?: string;
}

export const analyticsService = {
  /**
   * Tracks entering a classroom
   */
  async trackCourseView(courseId: string, courseName: string, totalSlides: number) {
    this._send('/api/analytics', {
      type: 'course_view',
      courseId,
      courseName,
      totalSlides,
    });
  },

  /**
   * Tracks moving to a specific slide
   */
  async trackSlideView(courseId: string, slideIndex: number) {
    this._send('/api/analytics', {
      type: 'slide_view',
      courseId,
      slideIndex,
    });
  },

  /**
   * Tracks incremental watch time
   */
  async trackWatchDuration(courseId: string, durationSeconds: number) {
    this._send('/api/analytics', {
      type: 'heartbeat',
      courseId,
      durationSeconds,
    });
  },

  /**
   * Submits a quiz score to the leaderboard and personal history
   */
  async submitQuizScore(submission: QuizSubmission) {
    return this._send('/api/analytics/quiz-score', submission);
  },

  /**
   * Internal helper to send events to the API
   */
  async _send(endpoint: string, data: any) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        console.warn(`[analytics] Failed to send event to ${endpoint}: ${response.statusText}`);
      }
      return await response.json();
    } catch (err) {
      // Analytics should never break the main app flow
      console.error('[analytics] Request error:', err);
    }
  }
};

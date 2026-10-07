'use client';

import { useEffect } from 'react';

import { whenAgentRegistryLoaded } from '@/lib/orchestration/registry/store';

/**
 * Read the owner's custom agents into the agent registry once per page (after
 * the one-time import of the ones an earlier build kept in this browser).
 * Renders nothing.
 */
export function AgentRegistryInit() {
  useEffect(() => {
    void whenAgentRegistryLoaded();
  }, []);

  return null;
}

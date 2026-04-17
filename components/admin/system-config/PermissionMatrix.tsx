'use client';

import { useRef, useEffect } from 'react';
import { PERMISSION_CATEGORIES } from '@/lib/admin/permissions';

interface PermissionMatrixProps {
  selectedPermissions: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
}

/**
 * Permission matrix UI — checkbox grid with categories and permissions
 */
export function PermissionMatrix({ selectedPermissions, onChange, disabled }: PermissionMatrixProps) {
  const categoryCheckboxRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const togglePermission = (perm: string) => {
    const updated = selectedPermissions.includes(perm)
      ? selectedPermissions.filter((p) => p !== perm)
      : [...selectedPermissions, perm];
    onChange(updated);
  };

  const toggleCategory = (categoryKey: string) => {
    const category = PERMISSION_CATEGORIES[categoryKey as keyof typeof PERMISSION_CATEGORIES];
    const perms = Object.keys(category.permissions);
    const allSelected = perms.every((p) => selectedPermissions.includes(p));

    if (allSelected) {
      onChange(selectedPermissions.filter((p) => !perms.includes(p)));
    } else {
      onChange([...new Set([...selectedPermissions, ...perms])]);
    }
  };

  // Update indeterminate state for category checkboxes
  useEffect(() => {
    Object.entries(PERMISSION_CATEGORIES).forEach(([categoryKey, category]) => {
      const perms = Object.keys(category.permissions);
      const someSelected = perms.some((p) => selectedPermissions.includes(p));
      const allSelected = perms.every((p) => selectedPermissions.includes(p));
      
      const checkbox = categoryCheckboxRefs.current.get(categoryKey);
      if (checkbox) {
        checkbox.indeterminate = someSelected && !allSelected;
      }
    });
  }, [selectedPermissions]);

  return (
    <div className="space-y-4">
      {Object.entries(PERMISSION_CATEGORIES).map(([categoryKey, category]) => {
        const perms = Object.entries(category.permissions);
        const allSelected = perms.every(([key]) => selectedPermissions.includes(key));

        return (
          <div key={categoryKey} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="mb-3 flex items-center gap-2">
              <input
                ref={(el) => {
                  if (el) categoryCheckboxRefs.current.set(categoryKey, el);
                }}
                type="checkbox"
                id={`category-${categoryKey}`}
                checked={allSelected}
                onChange={() => toggleCategory(categoryKey)}
                disabled={disabled}
                className="w-4 h-4 accent-purple-500 cursor-pointer disabled:opacity-50"
              />
              <label
                htmlFor={`category-${categoryKey}`}
                className="text-sm font-semibold text-white cursor-pointer disabled:opacity-50"
              >
                {category.label}
              </label>
            </div>

            <div className="ml-6 space-y-2">
              {perms.map(([permKey, permLabel]) => (
                <div key={permKey} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`perm-${permKey}`}
                    checked={selectedPermissions.includes(permKey)}
                    onChange={() => togglePermission(permKey)}
                    disabled={disabled}
                    className="w-4 h-4 accent-purple-500 cursor-pointer disabled:opacity-50"
                  />
                  <label
                    htmlFor={`perm-${permKey}`}
                    className="text-sm text-slate-300 cursor-pointer disabled:opacity-50"
                  >
                    {permLabel}
                  </label>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

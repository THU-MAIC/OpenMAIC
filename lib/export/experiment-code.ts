export type ExperimentCodeKind = 'signal' | 'sorting' | 'general' | 'source';

export interface ExperimentCodeInput {
  readonly title?: string;
  readonly description?: string;
  readonly keyPoints?: readonly string[];
  readonly widgetType?: string;
  readonly language?: string;
  readonly sourceCode?: string;
}

export interface ExperimentCode {
  readonly language: string;
  readonly kind: ExperimentCodeKind;
  readonly code: string;
  readonly exerciseCode: string;
  readonly objective: string;
  readonly principle: string;
  readonly task: string;
  readonly assertionRules: readonly string[];
}

function contextText(input: ExperimentCodeInput): string {
  return [input.title, input.description, ...(input.keyPoints ?? []), input.widgetType]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function cleanTitle(title: string | undefined): string {
  return (title || '本节实验').replace(/[\r\n]+/g, ' ').trim();
}

function pythonString(value: string): string {
  return JSON.stringify(value) || '"本节实验"';
}

function isUsefulSource(sourceCode: string | undefined): sourceCode is string {
  if (!sourceCode || sourceCode.trim().length < 80) return false;
  return !/result\s*=\s*explore\(|print\(['"]正在演示/u.test(sourceCode);
}

function buildGeneralExercise(title: string): string {
  return `# 练习任务：请修改参数或实现自己的数据处理逻辑，再运行本单元完成自测
import numpy as np
import matplotlib.pyplot as plt

# TODO 1：尝试修改频率、噪声强度或采样点数，观察图表变化
SAMPLE_RATE = 1_000
DURATION = 1.0
time = np.linspace(0.0, DURATION, 400, endpoint=False)
wave = np.sin(2.0 * np.pi * 3.0 * time)

# TODO 2：在这里加入你的实验算法，并保证输出 wave 与 time 等长
assert len(wave) == len(time), "波形与时间轴长度不一致"
assert np.isfinite(wave).all(), "波形包含无效数值"

plt.figure(figsize=(10, 4))
plt.plot(time, wave, color="#635bff", label=${pythonString(title)})
plt.xlabel("Time (s)")
plt.ylabel("Amplitude")
plt.grid(alpha=0.25)
plt.legend()
plt.show()
print("🎉 所有断言测试通过！")`;
}

function buildSignalExercise(title: string): string {
  return `# 练习任务：完成波形生成与主频测量；可修改 TARGET_FREQUENCY 观察断言变化
import numpy as np
import matplotlib.pyplot as plt

SAMPLE_RATE = 1_000
DURATION = 1.0
TARGET_FREQUENCY = 50.0

def build_wave(frequency=TARGET_FREQUENCY, sample_rate=SAMPLE_RATE, duration=DURATION):
    # TODO：把下面的单一正弦波改成两个正弦分量的叠加
    time = np.arange(0.0, duration, 1.0 / sample_rate)
    wave = np.sin(2.0 * np.pi * frequency * time)
    return time, wave

time, wave = build_wave()
spectrum = np.fft.rfft(wave)
frequencies = np.fft.rfftfreq(len(wave), d=1.0 / SAMPLE_RATE)
magnitudes = 2.0 / len(wave) * np.abs(spectrum)
peak_index = int(np.argmax(magnitudes[1:]) + 1)
freq = float(frequencies[peak_index])

# 规范断言评测：学生修改 TODO 后仍需满足这些实验契约
assert len(wave) == 1_000, "采样点数不符"
assert np.isclose(freq, 50.0, atol=1.0), "主频计算错误"

plt.figure(figsize=(10, 4))
plt.plot(time, wave, color="#635bff", label=${pythonString(title)})
plt.title("练习结果 · 时域波形")
plt.xlabel("Time (s)")
plt.ylabel("Amplitude")
plt.grid(alpha=0.25)
plt.legend()
plt.show()
print("🎉 所有断言测试通过！")`;
}

function buildSortingExercise(title: string): string {
  return `# 练习任务：完成排序函数，保证输出有序且不丢失元素
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(7)
data = rng.integers(0, 100, size=18)

def student_sort(values):
    # TODO：实现你的排序算法（例如归并排序、快速排序或堆排序）
    return sorted(values)

sorted_data = student_sort(data.tolist())
assert len(sorted_data) == len(data), "排序后元素数量发生变化"
assert sorted_data == sorted(data.tolist()), "排序结果不正确"
assert all(a <= b for a, b in zip(sorted_data, sorted_data[1:])), "结果不是非递减序列"

plt.figure(figsize=(10, 4))
plt.plot(np.arange(len(data)), data, "o-", color="#a78bfa", label="before")
plt.plot(np.arange(len(sorted_data)), sorted_data, "o-", color="#22c55e", label="after")
plt.title(${pythonString(title)} + " · 排序前后")
plt.xlabel("Index")
plt.ylabel("Value")
plt.grid(alpha=0.25)
plt.legend()
plt.show()
print("🎉 所有断言测试通过！")`;
}

function buildSignalExperiment(title: string): string {
  return `"""${title}：从时域到频域的可复现实验。"""
import numpy as np
import matplotlib.pyplot as plt

# 1) 采样并叠加两个正弦分量，观察波形在时域中的形状
SAMPLE_RATE = 1_000  # Hz
DURATION = 1.0       # s
COMPONENTS = ((50.0, 1.0), (120.0, 0.35))  # (frequency_hz, amplitude)

t = np.arange(0.0, DURATION, 1.0 / SAMPLE_RATE)
wave = sum(
    amplitude * np.sin(2.0 * np.pi * frequency * t)
    for frequency, amplitude in COMPONENTS
)

# 2) 自动批改断言：采样点数、频率轴与主峰必须符合实验设定
expected_samples = int(SAMPLE_RATE * DURATION)
assert len(wave) == expected_samples, f"采样点数错误：{len(wave)} != {expected_samples}"

spectrum = np.fft.rfft(wave)
frequencies = np.fft.rfftfreq(t.size, d=1.0 / SAMPLE_RATE)
amplitude_spectrum = 2.0 / t.size * np.abs(spectrum)
peak_index = int(np.argmax(amplitude_spectrum[1:]) + 1)
peak_frequency = float(frequencies[peak_index])
assert np.isclose(frequencies[1] - frequencies[0], 1.0 / DURATION)
assert np.isclose(peak_frequency, COMPONENTS[0][0], atol=1.0), (
    f"主频计算错误：{peak_frequency:.2f} Hz"
)

# 3) 可视化：分别绘制时域与 FFT 频域，便于对比波形与频率峰值
plt.figure(figsize=(11, 4.5), constrained_layout=True)
plt.plot(t, wave, color="#635bff", linewidth=1.8, label="combined signal")
plt.title(${pythonString(`${title} · Time domain`)})
plt.xlabel("Time (s)")
plt.ylabel("Amplitude")
plt.grid(alpha=0.25)
plt.legend()

plt.figure(figsize=(11, 4.5), constrained_layout=True)
plt.plot(frequencies, amplitude_spectrum, color="#f97316", linewidth=1.8, label="FFT magnitude")
plt.scatter([peak_frequency], [amplitude_spectrum[peak_index]], color="#dc2626", zorder=3)
plt.xlim(0, 30)
plt.title(f"Frequency domain · 频域（主峰 {peak_frequency:.1f} Hz）")
plt.xlabel("Frequency (Hz)")
plt.ylabel("Magnitude")
plt.grid(alpha=0.25)
plt.legend()
print("🎉 所有断言测试通过！")
plt.show()`;
}

function buildSortingExperiment(title: string): string {
  return `"""${title}：用归并排序验证分治算法。"""
import numpy as np
import matplotlib.pyplot as plt

def merge_sort(values):
    """稳定的 O(n log n) 归并排序，返回新列表。"""
    if len(values) <= 1:
        return values.copy()
    middle = len(values) // 2
    left = merge_sort(values[:middle])
    right = merge_sort(values[middle:])
    merged = []
    left_index = right_index = 0
    while left_index < len(left) and right_index < len(right):
        if left[left_index] <= right[right_index]:
            merged.append(left[left_index])
            left_index += 1
        else:
            merged.append(right[right_index])
            right_index += 1
    return merged + left[left_index:] + right[right_index:]

rng = np.random.default_rng(7)
data = rng.integers(0, 100, size=18)
sorted_data = merge_sort(data.tolist())

# 自动批改断言：结果必须有序，且不能丢失或重复元素
assert len(sorted_data) == len(data), "排序后元素数量发生变化"
assert sorted_data == sorted(data.tolist()), "归并排序结果不正确"
assert all(a <= b for a, b in zip(sorted_data, sorted_data[1:])), "结果不是非递减序列"

fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), constrained_layout=True)
fig.suptitle(${pythonString(title)}, fontsize=16, fontweight="bold")
axes[0].bar(np.arange(data.size), data, color="#a78bfa")
axes[0].set_title("Before sorting · 排序前")
axes[0].set_xlabel("Original index")
axes[0].set_ylabel("Value")
axes[0].grid(axis="y", alpha=0.25)
axes[1].bar(np.arange(len(sorted_data)), sorted_data, color="#22c55e")
axes[1].set_title("After merge sort · 排序后")
axes[1].set_xlabel("Sorted index")
axes[1].set_ylabel("Value")
axes[1].grid(axis="y", alpha=0.25)
plt.show()`;
}

function buildGeneralExperiment(title: string): string {
  return `"""${title}：用可复现数据完成一次观察实验。"""
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(7)
x = np.linspace(0.0, 1.0, 400)
signal = np.sin(2.0 * np.pi * 3.0 * x)
noise = rng.normal(0.0, 0.08, size=x.size)
observations = signal + noise

# 自动批改断言：数据形状与采样范围必须满足实验约束
assert x.size == 400, f"采样点数错误：{x.size}"
assert observations.shape == x.shape
assert np.isclose(x[0], 0.0) and np.isclose(x[-1], 1.0)

fig, axis = plt.subplots(figsize=(11, 4.8), constrained_layout=True)
axis.plot(x, signal, color="#635bff", linewidth=2.0, label="reference signal")
axis.scatter(x[::8], observations[::8], s=12, alpha=0.55, color="#f97316", label="observations")
axis.set_title(${pythonString(title)})
axis.set_xlabel("Normalized time")
axis.set_ylabel("Value")
axis.grid(alpha=0.25)
axis.legend()
plt.show()`;
}

/**
 * Select a runnable experiment from the semantic context of a chapter.
 * The templates intentionally use only NumPy and Matplotlib so a fresh
 * notebook kernel can run them without project-specific helpers.
 */
function completeExperiment(
  input: ExperimentCodeInput,
  kind: ExperimentCodeKind,
  code: string,
): ExperimentCode {
  const title = cleanTitle(input.title);
  if (kind === 'signal') {
    return {
      language: 'python',
      kind,
      code,
      exerciseCode: buildSignalExercise(title),
      objective: '生成采样时域波形，并用 FFT 找到信号的主频。',
      principle: '离散信号可以通过快速傅里叶变换映射到频域；频谱峰值对应信号中的主要频率分量。',
      task: '运行实验代码后，修改练习单元中的波形生成逻辑，确保采样点数和主频断言仍然通过。',
      assertionRules: ['len(wave) == 1000', '频域主峰接近 50 Hz', '波形数据全部为有限数值'],
    };
  }

  if (kind === 'sorting') {
    return {
      language: 'python',
      kind,
      code,
      exerciseCode: buildSortingExercise(title),
      objective: '实现并验证一个排序算法，理解分治或比较排序的基本过程。',
      principle: '排序算法需要保持元素完整性，并将输入序列转换为非递减序列。',
      task: '在 TODO 位置实现自己的排序算法，再运行断言单元检查结果。',
      assertionRules: [
        '排序前后元素数量一致',
        '排序结果与 Python 基准结果一致',
        '结果满足非递减关系',
      ],
    };
  }

  return {
    language: input.language?.toLowerCase() || 'python',
    kind,
    code,
    exerciseCode: buildGeneralExercise(title),
    objective: '通过可复现数据完成一次从计算到可视化的完整实验。',
    principle: '先构造数据并验证形状，再使用图表观察数据规律。',
    task: '修改 TODO 参数或算法逻辑，观察图表变化，并保证所有断言通过。',
    assertionRules: ['波形与时间轴长度一致', '数组中不存在无效数值'],
  };
}

export function buildExperimentCode(input: ExperimentCodeInput): ExperimentCode {
  const context = contextText(input);

  if (
    /(傅里叶|fourier|fft|频域|时域|波形|正弦|信号|signal|wave|spectrum|采样|sampling|滤波|filter|振动|振荡|频率|frequency|工程|engineering|电路|circuit)/iu.test(
      context,
    )
  ) {
    return completeExperiment(input, 'signal', buildSignalExperiment(cleanTitle(input.title)));
  }

  if (
    /(排序|sort|快速排序|归并|冒泡|堆排序|算法|algorithm|复杂度|complexity|搜索|search|二分|binary|链表|linked list|图算法|graph)/iu.test(
      context,
    )
  ) {
    return completeExperiment(input, 'sorting', buildSortingExperiment(cleanTitle(input.title)));
  }

  if (isUsefulSource(input.sourceCode)) {
    return completeExperiment(input, 'source', input.sourceCode.trim());
  }

  return completeExperiment(input, 'general', buildGeneralExperiment(cleanTitle(input.title)));
}

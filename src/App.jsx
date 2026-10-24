import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTimeline, shiftSubsequentSlotsForHourChange } from './scheduler.js';
import { mostCommonFileDate } from './fileDates.js';

const STORAGE_KEY = 'multiple-file-date-time-editor.v1';
const naturalName = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function blankSchedule(index) {
  return {
    id: crypto.randomUUID(),
    name: `시간표 ${index + 1}`,
    slots: Array.from({ length: 50 }, () => ''),
  };
}

function localDateValue(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeFromSlot(value) {
  if (!value) return '';
  const time = String(value).includes('T') ? String(value).split('T')[1] : String(value);
  const match = time.match(/^(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return '';
  return `${match[1]}:${match[2] || '00'}.${(match[3] || '0').padEnd(3, '0')}`;
}

function loadSavedState() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (value?.schedules?.length) {
      const schedules = value.schedules.map((schedule, index) => ({
        id: schedule.id || crypto.randomUUID(),
        name: schedule.name || `시간표 ${index + 1}`,
        slots: Array.isArray(schedule.slots) ? schedule.slots.map(timeFromSlot) : [],
      }));
      const activeId = schedules.some((schedule) => schedule.id === value.activeId)
        ? value.activeId
        : schedules[0].id;
      return {
        schedules,
        activeId,
        selectedDate: value.selectedDate || localDateValue(),
      };
    }
  } catch {
    // Start with the default schedules if browser storage is unavailable.
  }
  const schedules = Array.from({ length: 4 }, (_, index) => blankSchedule(index));
  return { schedules, activeId: schedules[0].id, selectedDate: localDateValue() };
}

function localInputValue(milliseconds) {
  const date = new Date(milliseconds);
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function localTimeValue(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '';
  return localInputValue(milliseconds).split('T')[1];
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toLocaleString('ko-KR', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

export default function App() {
  const initial = useMemo(loadSavedState, []);
  const [schedules, setSchedules] = useState(initial.schedules);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [selectedDate, setSelectedDate] = useState(initial.selectedDate);
  const [files, setFiles] = useState([]);
  const [manualOverrides, setManualOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  const [activePreview, setActivePreview] = useState(null);
  const [editingScheduleName, setEditingScheduleName] = useState(false);
  const [scheduleNameDraft, setScheduleNameDraft] = useState('');
  const [copiedTimeSlot, setCopiedTimeSlot] = useState('');
  const dragDepth = useRef(0);
  const activeSchedule = schedules.find((schedule) => schedule.id === activeId) || schedules[0];
  const { preview, candidatesCount, stoppedAt, invalidOrderEvents } = useMemo(
    () => buildTimeline(files, activeSchedule?.slots || [], selectedDate, manualOverrides),
    [files, activeSchedule, selectedDate, manualOverrides],
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schedules, activeId, selectedDate }));
    } catch {
      setError('시간표를 이 PC에 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
    }
  }, [schedules, activeId, selectedDate]);

  function updateSlots(transform) {
    setSchedules((current) => current.map((schedule) => (
      schedule.id === activeId ? { ...schedule, slots: transform(schedule.slots) } : schedule
    )));
  }

  function updateSlot(index, value) {
    updateSlots((slots) => shiftSubsequentSlotsForHourChange(slots, index, value));
  }

  function addSchedule() {
    const next = blankSchedule(schedules.length);
    setSchedules((current) => [...current, next]);
    setActiveId(next.id);
    setEditingScheduleName(false);
  }

  function duplicateSchedule() {
    if (!activeSchedule) return;
    const copy = {
      id: crypto.randomUUID(),
      name: `시간표 ${schedules.length + 1}`,
      slots: [...activeSchedule.slots],
    };
    setSchedules((current) => [...current, copy]);
    setActiveId(copy.id);
    setManualOverrides({});
    setEditingScheduleName(false);
  }

  function beginRenameSchedule() {
    if (!activeSchedule) return;
    setScheduleNameDraft(activeSchedule.name);
    setEditingScheduleName(true);
  }

  function saveScheduleName() {
    if (!activeSchedule) return;
    const name = scheduleNameDraft.trim();
    if (!name) setScheduleNameDraft(activeSchedule.name);
    else {
      setSchedules((current) => current.map((schedule) => (
        schedule.id === activeSchedule.id ? { ...schedule, name } : schedule
      )));
    }
    setActiveId(activeSchedule.id);
    setEditingScheduleName(false);
  }

  function updateScheduleNameDraft(value) {
    setScheduleNameDraft(value);
  }

  function deleteSchedule() {
    if (!activeSchedule || schedules.length <= 1) return;
    if (!window.confirm(`'${activeSchedule.name}' 시간표를 삭제할까요? 삭제한 시간표는 복구할 수 없습니다.`)) return;
    const currentIndex = schedules.findIndex((schedule) => schedule.id === activeId);
    const remaining = schedules.filter((schedule) => schedule.id !== activeId);
    setSchedules(remaining);
    setActiveId(remaining[Math.max(0, currentIndex - 1)].id);
    setManualOverrides({});
    setEditingScheduleName(false);
  }

  function addTimeSlot() {
    updateSlots((slots) => [...slots, '']);
  }

  function insertTimeSlotAfter(index) {
    updateSlots((slots) => [...slots.slice(0, index + 1), '', ...slots.slice(index + 1)]);
  }

  function removeTimeSlot(index) {
    updateSlots((slots) => slots.filter((_, slotIndex) => slotIndex !== index));
  }

  function pasteTimeSlot(index) {
    if (!copiedTimeSlot) return;
    updateSlots((slots) => slots.map((slot, slotIndex) => (
      slotIndex === index ? copiedTimeSlot : slot
    )));
  }

  function updateEvent(field, fileIndex, value) {
    const overrideKey = `${field}:${fileIndex}`;
    const time = timeFromSlot(value);
    if (!time) {
      setManualOverrides((current) => {
        const next = { ...current };
        delete next[overrideKey];
        return next;
      });
      return;
    }
    setManualOverrides((current) => ({ ...current, [overrideKey]: time }));
  }

  function selectFiles(nextFiles, { sort = false, append = false, insertIndex = null } = {}) {
    const ordered = sort
      ? [...nextFiles].sort((a, b) => naturalName.compare(a.name, b.name))
      : [...nextFiles];
    const position = Number.isInteger(insertIndex)
      ? Math.max(0, Math.min(insertIndex, files.length))
      : files.length;
    const combined = append
      ? [...files.slice(0, position), ...ordered, ...files.slice(position)]
      : ordered;
    const seen = new Set();
    const uniqueFiles = combined.filter((file) => {
      const key = String(file.path).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setFiles(uniqueFiles);
    setSelectedDate(mostCommonFileDate(uniqueFiles, localDateValue()));
    setManualOverrides({});
  }

  async function chooseFiles({ insertIndex = null } = {}) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api('/api/files/choose', { method: 'POST' });
      if (result.cancelled) return;
      selectFiles(result.files, { sort: true, append: true, insertIndex });
      setMessage(insertIndex === null
        ? `${result.files.length.toLocaleString('ko-KR')}개 파일을 목록 끝에 추가했습니다.`
        : `${result.files.length.toLocaleString('ko-KR')}개 파일을 ${insertIndex + 1}번 파일 앞에 삽입했습니다.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleDragEnter(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleRowDragOver(event, index) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropTargetIndex(index);
  }

  function handleRowDragEnter(event, index) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetIndex(index);
  }

  function handleRowDragLeave(event, index) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (dropTargetIndex === index && !event.currentTarget.contains(event.relatedTarget)) setDropTargetIndex(null);
  }

  function removeFile(index) {
    const removedPath = files[index]?.path;
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    setManualOverrides({});
    if (activePreview?.path === removedPath) setActivePreview(null);
  }

  function moveFile(index, offset) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= files.length) return;
    setFiles((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    setManualOverrides({});
  }

  async function handleDrop(event, insertIndex = null) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    setDropTargetIndex(null);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const filePaths = droppedFilePaths(event.dataTransfer.files);
      if (filePaths.length === 0) return;
      const result = await api('/api/files/resolve', { method: 'POST', body: { filePaths } });
      selectFiles(result.files, { append: true, insertIndex });
      setMessage(insertIndex === null
        ? `${result.files.length.toLocaleString('ko-KR')}개 파일을 드롭한 순서대로 목록 끝에 추가했습니다.`
        : `${result.files.length.toLocaleString('ko-KR')}개 파일을 ${insertIndex + 1}번 파일 앞에 드롭해 삽입했습니다.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyDates() {
    if (!files.length || busy || preview.some((file) => file.createdMs === null || file.modifiedMs === null)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api('/api/files/timeline', {
        method: 'POST',
        body: {
          files: preview.map((file) => ({
            filePath: file.path,
            createdAt: localInputValue(file.createdMs),
            modifiedAt: localInputValue(file.modifiedMs),
          })),
        },
      });
      setFiles(result.files);
      setMessage(`${result.files.length.toLocaleString('ko-KR')}개 파일의 만든 날짜와 수정한 날짜를 변경했습니다.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canApply = files.length > 0 && preview.length === files.length
    && preview.every((file) => file.createdMs !== null && file.modifiedMs !== null)
    && invalidOrderEvents.length === 0 && !busy;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <main className="page-shell">
      <section className="tool-card" aria-labelledby="page-title">
        <header className="tool-header">
          <div className="eyebrow">LOCAL FILE UTILITY</div>
          <h1 id="page-title">Multiple File Date Time Editor</h1>
          <p>시간표를 따라 여러 파일의 만든 날짜와 수정한 날짜를 순서대로 배정합니다.</p>
        </header>

        <section className="schedule-panel" aria-label="시간표">
          <div className="section-heading">
            <div>
              <h2>시간표 세트</h2>
              <p>입력한 시각은 이 PC에 자동 저장됩니다.</p>
            </div>
            <div className="schedule-actions">
              {editingScheduleName ? (
                <>
                  <button className="secondary-button compact" type="button" onClick={saveScheduleName} disabled={busy}>완료</button>
                </>
              ) : (
                <>
                  <button className="secondary-button compact" type="button" onClick={beginRenameSchedule} disabled={busy}>이름 변경</button>
                  <button className="secondary-button compact danger-button" type="button" onClick={deleteSchedule} disabled={busy || schedules.length <= 1} title={schedules.length <= 1 ? '마지막 시간표는 삭제할 수 없습니다.' : '현재 시간표 삭제'}>시간표 삭제</button>
                </>
              )}
              <button className="secondary-button compact" type="button" onClick={duplicateSchedule} disabled={busy}>현재 시간표 복제</button>
              <button className="secondary-button compact" type="button" onClick={addSchedule} disabled={busy}>+ 시간표 추가</button>
            </div>
          </div>
          {editingScheduleName && (
            <div className="schedule-rename">
              <label htmlFor="schedule-name">선택한 시간표 이름</label>
              <input
                id="schedule-name"
                type="text"
                maxLength={40}
                value={scheduleNameDraft}
                onChange={(event) => updateScheduleNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveScheduleName();
                  if (event.key === 'Escape') {
                    setScheduleNameDraft(activeSchedule?.name || '');
                    setEditingScheduleName(false);
                  }
                }}
                autoFocus
                disabled={busy}
              />
            </div>
          )}
          <div className="schedule-tabs" role="tablist" aria-label="저장된 시간표">
            {schedules.map((schedule, index) => (
              <button
                className={`schedule-tab ${schedule.id === activeId ? 'active' : ''}`}
                key={schedule.id}
                type="button"
                role="tab"
                aria-selected={schedule.id === activeId}
                onClick={() => { setActiveId(schedule.id); setManualOverrides({}); setEditingScheduleName(false); }}
              >
                {schedule.name || `시간표 ${index + 1}`}
              </button>
            ))}
          </div>
          <div className="schedule-tools">
            <strong>{activeSchedule?.slots.length || 0}개 시각 입력란</strong>
            <span>연·월·일 없이 시:분:초.밀리초까지 입력합니다. 빈 칸은 건너뛰고 앞에서 뒤 순서로 입력하세요.</span>
            <button className="text-button" type="button" onClick={addTimeSlot}>+ 입력란 추가</button>
          </div>
          <div className="slot-grid">
            {(activeSchedule?.slots || []).map((value, index) => (
              <div className="slot-field" key={`${activeId}-${index}`}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <TimeSlotInput
                  key={`${activeId}-${index}-${value}`}
                  value={value}
                  label={`시간표 ${index + 1}번 시각`}
                  disabled={busy}
                  onCommit={(nextValue) => updateSlot(index, nextValue)}
                />
                <div className="slot-actions">
                  <button className="slot-action-button" type="button" onClick={() => setCopiedTimeSlot(value)} disabled={busy || !value} aria-label={`${index + 1}번 시간 슬롯 복사`} title="시간 슬롯 복사">⧉</button>
                  <button className="slot-action-button" type="button" onClick={() => pasteTimeSlot(index)} disabled={busy || !copiedTimeSlot} aria-label={`${index + 1}번 칸에 복사한 시간 붙여넣기`} title="복사한 시간 붙여넣기">↧</button>
                  <button className="slot-action-button" type="button" onClick={() => insertTimeSlotAfter(index)} disabled={busy} aria-label={`${index + 1}번 뒤에 시간 슬롯 삽입`} title="이 슬롯 다음에 삽입">+</button>
                  <button className="slot-action-button remove" type="button" onClick={() => removeTimeSlot(index)} disabled={busy} aria-label={`${index + 1}번 시간 슬롯 삭제`} title="이 슬롯 삭제">−</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          className={`file-picker ${files.length ? 'has-file' : ''} ${dragActive ? 'drag-active' : ''}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragActive && <div className="drop-overlay" aria-hidden="true"><strong>파일을 여기에 놓으세요</strong><span>놓은 순서대로 목록 끝에 추가됩니다</span></div>}
          <div className="drop-copy">
            <strong>{files.length ? `${files.length.toLocaleString('ko-KR')}개 파일 선택됨` : '파일을 끌어 놓으세요'}</strong>
            <span>{files.length ? `${formatBytes(totalBytes)} · 드롭 영역에 놓으면 끝에 추가, 목록 행에 놓으면 그 앞에 삽입됩니다.` : '여러 파일을 드롭하면 목록 끝에 추가됩니다.'}</span>
          </div>
          <button className="secondary-button" type="button" onClick={chooseFiles} disabled={busy}>파일 추가</button>
          {files.length > 0 && <button className="text-button clear-button" type="button" onClick={() => { setFiles([]); setManualOverrides({}); setActivePreview(null); }} disabled={busy}>목록 비우기</button>}
        </section>

        <div className="date-setting">
          <label htmlFor="schedule-date">배정 날짜</label>
          <input
            id="schedule-date"
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            disabled={busy}
          />
          <span>파일을 불러올 때 만든/수정 날짜를 모두 세어 최빈 날짜를 선택합니다. 필요하면 직접 바꾸세요.</span>
        </div>
        {files.length > 0 && !selectedDate && <div className="alert warning">배정 날짜를 선택해 주세요.</div>}

        <section className="model-note">
          <strong>크기별 기준 간격</strong>
          <span>2025년 자료 8,587개에서 용량별 평균을 계산했습니다. 선택 파일의 원본 생성/수정 차이를 우선 쓰고, 평균의 1.5배를 넘으면 평균으로 제한합니다.</span>
        </section>

        <section className="preview-panel">
          <div className="section-heading preview-heading">
            <div>
              <h2>배정 미리보기</h2>
              <p>드롭 영역에 놓으면 목록 끝에 추가되고, 파일 행에 놓으면 그 앞에 삽입됩니다. 행별로 삽입·순서 변경·제거도 할 수 있습니다.</p>
              <p>시각을 직접 고치면 해당 생성/수정 시각의 연결만 끊깁니다. 생성 시각을 고쳐도 앞 파일의 수정 시각은 유지되고, 그 이후부터 자동 배정됩니다.</p>
            </div>
            <div className="candidate-count">사용 가능한 시간표 시각 <strong>{candidatesCount}</strong></div>
          </div>
          {files.length === 0 ? (
            <div className="empty-state">파일을 선택하면 크기별 기준 간격과 배정 결과가 표시됩니다.</div>
          ) : (
            <>
              {activePreview && <VideoPreview file={activePreview} onClose={() => setActivePreview(null)} />}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>#</th><th>파일</th><th>용량</th><th>평균 / 원본 → 적용 간격</th><th>만든 시각</th><th>수정 시각</th><th>영상</th><th>목록 조작</th></tr></thead>
                  <tbody>
                    {preview.map((file, index) => (
                      <tr
                        className={dropTargetIndex === index ? 'file-row-drop-target' : ''}
                        key={file.path}
                        onDragEnter={(event) => handleRowDragEnter(event, index)}
                        onDragOver={(event) => handleRowDragOver(event, index)}
                        onDragLeave={(event) => handleRowDragLeave(event, index)}
                        onDrop={(event) => handleDrop(event, index)}
                        title="파일을 이 행에 놓으면 이 파일 앞에 삽입됩니다."
                      >
                        <td className="row-number">{index + 1}</td>
                        <td className="filename" title={file.path}>{file.name}</td>
                        <td className="numeric-cell">{formatBytes(file.size)}</td>
                        <td className="gap-details">
                          <span>평균 {formatGap(file.modelGapMs)}</span>
                          <span>원본 {formatGap(file.actualGapMs)}</span>
                          <strong>적용 {formatGap(file.estimatedGapMs)}</strong>
                        </td>
                        <td><EventInput value={file.createdMs} manual={file.createdManual} disabled={busy} onChange={(value) => updateEvent('created', index, value)} /></td>
                        <td><EventInput value={file.modifiedMs} manual={file.modifiedManual} disabled={busy} onChange={(value) => updateEvent('modified', index, value)} /></td>
                        <td>{file.canPreview && <button className="play-button" type="button" onClick={() => setActivePreview(file)} aria-label={`${file.name} 재생`}>▶ 재생</button>}</td>
                        <td>
                          <div className="file-row-actions">
                            <button className="row-action-button" type="button" onClick={() => chooseFiles({ insertIndex: index })} disabled={busy} aria-label={`${index + 1}번 앞에 파일 삽입`}>삽입</button>
                            <button className="row-action-button" type="button" onClick={() => moveFile(index, -1)} disabled={busy || index === 0} aria-label={`${index + 1}번 파일 위로 이동`}>↑</button>
                            <button className="row-action-button" type="button" onClick={() => moveFile(index, 1)} disabled={busy || index === files.length - 1} aria-label={`${index + 1}번 파일 아래로 이동`}>↓</button>
                            <button className="row-action-button remove" type="button" onClick={() => removeFile(index)} disabled={busy} aria-label={`${file.name} 목록에서 제거`}>제거</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {stoppedAt >= 0 && files.length > 0 && (
            <div className="alert warning">시간표 후보가 부족해 {stoppedAt === 0 ? '첫 파일' : `${stoppedAt}번 파일`}부터 배정되지 않았습니다. 시간을 더 추가하거나 앞선 시각을 조정해 주세요.</div>
          )}
          {invalidOrderEvents.length > 0 && (
            <div className="alert warning">모든 이벤트 시각은 앞선 시각보다 나중이어야 합니다. 순서를 고치면 날짜 변경을 진행할 수 있습니다.</div>
          )}
        </section>

        <div className="status-area" aria-live="polite">
          {error && <div className="alert error">{error}</div>}
          {message && <div className="alert success">{message}</div>}
        </div>
        <div className="actions">
          <span className="privacy-note"><i /> 파일은 업로드되지 않고 이 PC에서만 변경됩니다.</span>
          <button className="primary-button" type="button" onClick={applyDates} disabled={!canApply}>
            {busy ? '처리 중…' : `${files.length || ''}개 파일 날짜 변경`}
          </button>
        </div>
      </section>
    </main>
  );
}

function VideoPreview({ file, onClose }) {
  const videoRef = useRef(null);
  const [playbackError, setPlaybackError] = useState('');
  const source = `/api/files/preview/${encodeURIComponent(file.previewId)}`;
  const isTransportStream = /\.(ts|m2ts)$/i.test(file.name);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    setPlaybackError('');
    const onError = () => {
      const code = video.error?.code;
      const detail = code ? ` (미디어 오류 ${code})` : '';
      setPlaybackError(`영상을 재생할 수 없습니다${detail}. TS 파일은 로컬 변환을 시도합니다. 변환 실패 시 원본 파일의 손상 여부를 확인해 주세요.`);
    };
    video.addEventListener('error', onError);
    video.src = source;
    video.load();
    video.play().catch(() => {});
    return () => {
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [file.previewId, source]);

  return (
    <section className="video-preview" aria-label="영상 미리 보기">
      <div className="video-preview-heading">
        <div><strong>{file.name}</strong><span>{isTransportStream ? 'TS → MP4 로컬 변환 · 첫 재생이 늦고 탐색이 제한될 수 있습니다' : '영상 미리 보기'}</span></div>
        <button className="text-button" type="button" onClick={onClose}>닫기</button>
      </div>
      <video ref={videoRef} controls playsInline preload="metadata" />
      {playbackError && <div className="alert error">{playbackError}</div>}
    </section>
  );
}

function TimeSlotInput({ value, label, disabled, onCommit }) {
  function handleBlur(event) {
    const normalized = timeFromSlot(event.currentTarget.value);
    if (normalized !== value) onCommit(normalized);
  }

  return (
    <input
      aria-label={label}
      type="time"
      step="0.001"
      defaultValue={value}
      onBlur={handleBlur}
      disabled={disabled}
    />
  );
}

function EventInput({ value, manual, disabled, onChange }) {
  return (
    <div className={`event-input ${manual ? 'manual' : ''}`}>
      <input
        aria-label="배정 시각 (직접 수정 가능)"
        type="time"
        step="0.001"
        value={localTimeValue(value)}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      {manual && <span title="수동 기준점">수동</span>}
    </div>
  );
}

function formatGap(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `약 ${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  return `약 ${seconds.toLocaleString('ko-KR', { maximumFractionDigits: seconds < 10 ? 2 : 1 })}초`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '요청을 처리하지 못했습니다.');
  return payload;
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function droppedFilePaths(fileList) {
  const getPathForFile = window.desktopFiles?.getPathForFile;
  if (typeof getPathForFile !== 'function') {
    throw new Error('파일 드래그 앤 드롭은 start-windows.cmd로 연 데스크톱 창에서 사용할 수 있습니다.');
  }
  return Array.from(fileList || []).map((file) => getPathForFile(file)).filter(Boolean);
}

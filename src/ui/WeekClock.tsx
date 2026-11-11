import { useGame } from '../app/store';
import { SPEED_STAGES, stageIndex } from '../app/speed';
import { DAY_START_HOUR, MINUTES_PER_DAY } from '../sim/constants';
import { dayIndex } from '../sim/world';

export const WEEK_DAYS=['Mon','Tue','Wed','Thu','Fri'];
/** Minutes into the working day. The last minute of the week belongs to
 * Friday afternoon (4:00 pm), not to a sixth morning: a plain remainder read
 * it, and anything stamped at the week's end, as "Fri · 8:00 am". */
export function minuteOfDay(minute:number) {
  return minute-dayIndex(minute)*MINUTES_PER_DAY;
}
export function weekTime(minute:number) {
  const within=minuteOfDay(minute), h=DAY_START_HOUR+Math.floor(within/60), m=within%60;
  return `${((h+11)%12)+1}:${String(m).padStart(2,'0')} ${h<12?'am':'pm'}`;
}

/** The original's bottom-right clock and five-position accelerator. */
export function WeekClock() {
  const game = useGame();
  const {sim,speed,paused,speedUp,speedDown,finishingWeek}=game;
  if(!sim)return null;
  const minute=sim.world.minute, stage=stageIndex(speed), h=DAY_START_HOUR+minuteOfDay(minute)/60;
  const day=WEEK_DAYS[dayIndex(minute)], time=weekTime(minute);
  const atMaximum=!paused&&(finishingWeek||stage===SPEED_STAGES.length-1);
  const state=finishingWeek?'Finishing week':paused?'Paused':speed===1?'Normal speed':`${speed} times speed`;
  return <section className="week-clock" aria-label={`Game clock: ${day}, ${time}, ${state}`} title={`${day} · ${time} · ${state}`}>
    <div className="clock-shoulders">
      <button aria-label="Slower" title="Slower (<)" onClick={speedDown} disabled={stage===0}>‹</button>
      <div className="clock-speed" aria-label={`Time speed: ${speed===1?'Normal':`${speed} times`}`}>
        <svg viewBox="0 0 100 28" aria-hidden>
          <path d="M10 24 Q50 -12 90 24" fill="none" stroke="currentColor"/>
          {SPEED_STAGES.map((s,i)=><circle key={s} cx={12+i*19} cy={i===0||i===4?22:i===1||i===3?10:6} r="2"/>) }
          <path d="M50 27 L50 3" stroke="currentColor" strokeWidth="2" transform={`rotate(${-65+stage*32.5} 50 27)`}/>
        </svg>
      </div>
      <button aria-label="Faster" title="Faster (>)" onClick={speedUp} disabled={stage===SPEED_STAGES.length-1}>›</button>
    </div>
    <div className="clock-dial" role="img" aria-label={time}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <path d="M6 18V6H18 M82 6H94V18 M94 82V94H82 M18 94H6V82" fill="none" stroke="#8a8069"/>
        <circle cx="50" cy="50" r="43" fill="#e6dfcc" stroke="#8a8069"/>
        {/* The working day runs 8 am to 4 pm: the hours between are not played, so the
            hand passes from IV straight to VIII of the next morning. The closed hours are
            shaded and the dial says which half of the day it is in. */}
        <path d="M50 50 L87.2 71.5 A43 43 0 0 1 12.8 71.5 Z" fill="#3e372b" fillOpacity=".13"><title>4 pm to 8 am: the night is not played</title></path>
        {Array.from({length:12},(_,i)=><line key={i} x1="50" y1="8" x2="50" y2={i%3===0?'17':'12'} stroke="#594a37" strokeWidth={i%3===0?'2':'1'} transform={`rotate(${i*30} 50 50)`}/>)}
        <text x="50" y="29">XII</text><text x="75" y="54">III</text><text x="50" y="80">VI</text><text x="25" y="54">IX</text>
        {/* Manual p.25: at maximum speed the dial shows no hands. */}
        {!atMaximum && <>
          <path d="M50 55 L50 28" stroke="#382c1f" strokeWidth="3" transform={`rotate(${h*30} 50 50)`}/>
          <path d="M50 57 L50 14" stroke="#382c1f" strokeWidth="2" transform={`rotate(${minuteOfDay(minute)%60*6} 50 50)`}/>
        </>}
        <text x="50" y="68" className="clock-ampm">{h<12?'AM':'PM'}</text>
        <circle cx="50" cy="50" r="3" fill="#382c1f"/>
      </svg>
    </div>
    <div className="clock-day">{day}</div>
  </section>;
}

import { useState } from 'react';
import { z } from 'zod';
import styles from './panel.module.css';

function Hello() {
  const [count, setCount] = useState(0);
  const valid = z.number().safeParse(count).success;
  return (
    <button
      className={styles.greeting}
      onClick={() => {
        setCount(count + 1);
      }}
    >
      {valid ? count : 'invalid'}
    </button>
  );
}

export default { pages: [{ path: 'hello', title: 'Hello', component: Hello }] };

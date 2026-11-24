import { Button, Dropdown } from '@heroui/react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemeMode } from './theme'

/**
 * ThemeSwitch is the colour mode control: light, dark, or follow the system.
 * It is shared by the console header and the login page so both offer the same
 * choice with the same behaviour.
 */
export default function ThemeSwitch({ className = '' }: { className?: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <Button isIconOnly variant="ghost" aria-label="颜色模式" className={className}>
          {theme === 'system' ? (
            <Monitor size={18} />
          ) : theme === 'light' ? (
            <Sun size={18} />
          ) : (
            <Moon size={18} />
          )}
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={[theme]}
          onAction={(key) => setTheme(String(key) as ThemeMode)}
        >
          <Dropdown.Item id="light" textValue="浅色">
            浅色
          </Dropdown.Item>
          <Dropdown.Item id="dark" textValue="深色">
            深色
          </Dropdown.Item>
          <Dropdown.Item id="system" textValue="跟随系统">
            跟随系统
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
